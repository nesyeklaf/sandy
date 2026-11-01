#!/usr/bin/env bash
# Server-side half of the fork deploy. Runs on the sandy server host.
# Usage: remote.sh deploy <tgz> [--force] [--skip-upgrade-test] | upgrade-test <tgz> | rollback [--with-db] | serve | status
#   deploy    refuse while other threads run a turn (--force overrides), run upgrade-test,
#             stop sandy, back up sandy.db + config + npm prefix, install <tgz>, set SANDY_APP_URL, start
#   upgrade-test  start <tgz> on a copy of this server's data (sandy.db, config, plugins) on spare
#             ports and check health, threads and plugin states; the live server keeps running
#   rollback  restore the npm prefix and config from the last backup; --with-db also
#             restores sandy.db (drops everything written since that deploy)
#   serve     publish the server tailnet-only through Tailscale Serve (needs sudo)
#   status    unit state, installed version, local and tailnet health
# Overrides: SANDY_UNIT (systemd user unit), SANDY_PORT (default 38886).
set -euo pipefail

case "${1:-}" in
  -h|--help|"") sed -n 2,12p "$0" | sed 's/^# //'; [ -n "${1:-}" ]; exit $? ;;
esac

log="$HOME/sandy-fork-deploy.log"
last_backup_file="$HOME/sandy-fork-last-backup"
port="${SANDY_PORT:-38886}"

find_unit() {
  if [ -n "${SANDY_UNIT:-}" ]; then echo "$SANDY_UNIT"; return; fi
  local units
  units=$(systemctl --user list-unit-files 'sandy-host-daemon-*.service' --no-legend | awk '{print $1}')
  [ "$(echo "$units" | grep -c .)" = 1 ] || { echo "Set SANDY_UNIT; found: ${units:-none}" >&2; exit 1; }
  echo "$units"
}
unit=$(find_unit)
data_dir=$(systemctl --user show -p Environment "$unit" | tr ' ' '\n' | sed -n 's/^SANDY_DATA_DIR=//p')
[ -d "$data_dir" ] || { echo "No SANDY_DATA_DIR in $unit" >&2; exit 1; }
sandy_app="$data_dir/npm/bin/sandy-app"

tailnet_url() {
  local name
  name=$(tailscale status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).Self.DNSName.replace(/\.$/,"")))')
  echo "https://$name:$port"
}

sandy_cli() {
  SANDY_SERVER_URL="http://127.0.0.1:$port" "$data_dir/npm/bin/sandy" "$@"
}

active_threads() {
  sandy_cli thread list --json --include-hidden | SELF="${SANDY_DEPLOY_SELF_THREAD:-}" node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  for (const t of JSON.parse(s)) if (t.status==="active" && t.id!==process.env.SELF) console.log(t.id+"  "+(t.title||""));
})'
}

free_port() {
  local p
  while :; do
    p=$((20000 + RANDOM % 10000))
    [ -z "$(ss -ltnH "sport = :$p")" ] && { echo "$p"; return; }
  done
}

upgrade_test() (
  tgz=$1
  test -f "$tgz" || { echo "No such tarball: $tgz"; exit 1; }
  u=$(mktemp -d /tmp/sandy-upgrade-test.XXXXXX)
  pid=""
  trap '[ -n "$pid" ] && kill -TERM -- "-$pid" 2>/dev/null; sleep 1; rm -rf "$u"' EXIT
  echo "=== $(date -Is) upgrade-test $tgz in $u"
  npm install -g --allow-scripts=better-sqlite3,node-pty,@parcel/watcher \
    --prefix "$u/npm" "$tgz" > "$u/npm-install.log" 2>&1 || { tail -20 "$u/npm-install.log"; exit 1; }
  mkdir -p "$u/data/plugins"
  (cd "$u/npm/lib/node_modules/sandy-app" && node -e '
const D=require("better-sqlite3");
new D(process.argv[1],{readonly:true}).backup(process.argv[2]).then(()=>console.log("db copied"),e=>{console.error(e);process.exit(1)})' \
    "$data_dir/sandy.db" "$u/data/sandy.db") || exit 1
  for f in config.json auth-secret auth.json; do
    if [ -e "$data_dir/$f" ]; then cp -a "$data_dir/$f" "$u/data/" || exit 1; fi
  done
  (cd "$data_dir/plugins" && tar --exclude='./*/host-data' -cf - .) | (cd "$u/data/plugins" && tar -xf -) || exit 1
  sport=$(free_port); hport=$(free_port)
  SANDY_DATA_DIR="$u/data" SANDY_SERVER_PORT="$sport" SANDY_HOST_DAEMON_PORT="$hport" \
    setsid node "$u/npm/lib/node_modules/sandy-app/dist/sandy-server.js" > "$u/server.log" 2>&1 < /dev/null &
  pid=$!
  code=000
  for _ in $(seq 1 90); do
    sleep 2
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$sport/health" || true)
    [ "$code" = 200 ] && break
    kill -0 "$pid" 2>/dev/null || break
  done
  if [ "$code" != 200 ]; then
    echo "upgrade-test FAILED: health $code"; tail -30 "$u/server.log"; exit 1
  fi
  sleep 20
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$sport/api/threads" || true)
  state=$(SANDY_SERVER_URL="http://127.0.0.1:$sport" "$u/npm/bin/sandy" plugin list 2>&1 | grep -E '^[a-z]' || true)
  bad=$(echo "$state" | awk '$2!="running" && $2!="disabled"')
  echo "threads api: $code; plugins: $(echo "$state" | awk '{print $2}' | sort | uniq -c | tr '\n' ' ')"
  if [ "$code" != 200 ] || [ -z "$state" ] || [ -n "$bad" ]; then
    echo "upgrade-test FAILED"
    [ -n "$bad" ] && echo "$bad"
    grep -iE 'error|fatal' "$u/server.log" | cut -c1-250 | sort | uniq -c | sort -rn | head -15
    exit 1
  fi
  echo "=== $(date -Is) upgrade-test passed"
)

deploy() {
  local tgz=$1 backup force=0 skip_test=0 busy
  shift
  for a in "$@"; do
    case "$a" in
      --force) force=1 ;;
      --skip-upgrade-test) skip_test=1 ;;
      *) echo "Unknown deploy flag: $a"; exit 1 ;;
    esac
  done
  test -f "$tgz"
  if [ "$force" = 0 ]; then
    busy=$(active_threads) || { echo "=== $(date -Is) deploy REFUSED: cannot list threads (is sandy down? --force overrides)"; exit 1; }
  else
    busy=""
  fi
  if [ -n "$busy" ]; then
    echo "=== $(date -Is) deploy REFUSED: threads are running a turn (restart would break them; --force overrides):"
    echo "$busy"
    exit 1
  fi
  if [ "$skip_test" = 0 ] && ! upgrade_test "$tgz"; then
    echo "=== $(date -Is) deploy aborted: upgrade test failed, the running version stays"
    exit 1
  fi
  backup="$data_dir/backup-pre-fork-$(date +%Y%m%d-%H%M%S)"
  echo "=== $(date -Is) deploy $tgz ($unit)"
  systemctl --user stop "$unit"
  mkdir -p "$backup"
  for f in sandy.db sandy.db-wal sandy.db-shm config.json; do
    [ -e "$data_dir/$f" ] && cp -a "$data_dir/$f" "$backup/"
  done
  cp -a "$data_dir/npm" "$backup/npm"
  echo "$backup" > "$last_backup_file"
  echo "backup: $backup"

  # Same native-module allowlist as the official machine installer.
  if ! npm install -g --allow-scripts=better-sqlite3,node-pty,@parcel/watcher \
      --prefix "$data_dir/npm" "$tgz"; then
    echo "npm install failed; restoring the previous package"
    rm -rf "$data_dir/npm"; cp -a "$backup/npm" "$data_dir/npm"
    systemctl --user start "$unit"
    exit 1
  fi
  SANDY_DATA_DIR="$data_dir" "$sandy_app" config set SANDY_APP_URL "$(tailnet_url)"
  systemctl --user start "$unit"
  echo "=== $(date -Is) deploy done"
}

rollback() {
  local backup
  backup=$(cat "$last_backup_file")
  test -d "$backup/npm"
  echo "=== $(date -Is) rollback from $backup $*"
  systemctl --user stop "$unit"
  rm -rf "$data_dir/npm"; cp -a "$backup/npm" "$data_dir/npm"
  [ -e "$backup/config.json" ] && cp -a "$backup/config.json" "$data_dir/config.json"
  if [ "${1:-}" = --with-db ]; then
    rm -f "$data_dir/sandy.db-wal" "$data_dir/sandy.db-shm"
    for f in sandy.db sandy.db-wal sandy.db-shm; do
      [ -e "$backup/$f" ] && cp -a "$backup/$f" "$data_dir/"
    done
  fi
  systemctl --user start "$unit"
  echo "=== $(date -Is) rollback done"
}

serve() {
  # Persists in tailscaled state across reboots. Never use Funnel: the sandy API is
  # unauthenticated and can run commands.
  sudo tailscale serve --bg --https="$port" "http://127.0.0.1:$port"
  tailscale serve status
}

status() {
  echo "unit:     $unit $(systemctl --user is-active "$unit")"
  echo "version:  $(node -p "require('$data_dir/npm/lib/node_modules/sandy-app/package.json').version")"
  echo "app url:  $(node -p "(require('$data_dir/config.json').config||{}).SANDY_APP_URL||'unset'")"
  echo "local:    $(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/")"
  echo "tailnet:  $(curl -s -o /dev/null -w '%{http_code}' "$(tailnet_url)/")"
  echo "last entries of $log (history, not this call):"
  tail -5 "$log" 2>/dev/null | sed 's/^/  | /' || true
}

cmd=$1; shift
case "$cmd" in
  deploy) deploy "$@" >>"$log" 2>&1 ;;
  upgrade-test) upgrade_test "$@" 2>&1 | tee -a "$log"; exit "${PIPESTATUS[0]}" ;;
  rollback) rollback "$@" >>"$log" 2>&1 ;;
  serve) serve ;;
  status) status ;;
  *) echo "Unknown command: $cmd" >&2; exit 1 ;;
esac
