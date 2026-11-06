#!/usr/bin/env bash
# Usage: staging.sh refresh [<tgz>] | start | stop | status | logs
#   refresh  stop staging, copy the live server's data (sandy.db, config, auth, plugins) into
#            $SANDY_STAGING_DIR, install <tgz> (default: the live install), disable plugins with
#            outside effects, serve it on the tailnet and start it
#   start/stop/status/logs  manage the sandy-staging user unit
# Overrides: SANDY_STAGING_DIR (default ~/sandy-staging), SANDY_STAGING_PORT (default 39886).
set -euo pipefail
live="${SANDY_LIVE_DATA_DIR:-$HOME/.sandy-machines/aemonke.getbb.app}"
dir="${SANDY_STAGING_DIR:-$HOME/sandy-staging}"
port="${SANDY_STAGING_PORT:-39886}"
dport=$((port + 2))
unit=sandy-staging
node_bin=$(dirname "$(command -v node)")
side_effect_plugins="automations push-notifications github keep-awake sandy--storage-retention sandy-sidebar-delegate side-chat scheduled-send browser-automation value work chief-of-staff"

tailnet_url() {
  local name
  name=$(tailscale status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).Self.DNSName.replace(/\.$/,"")))')
  echo "https://$name:$port"
}

write_unit() {
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/$unit.service" <<EOF
[Unit]
Description=Sandy staging instance (copy of the live data)

[Service]
ExecStart="$node_bin/node" "$dir/npm/bin/sandy-app" "start" "--data-dir" "$dir/data" "--server-port" "$port" "--host-daemon-port" "$dport"
Environment="SANDY_APP_NPM_PREFIX=$dir/npm"
Environment="SANDY_DATA_DIR=$dir/data"
Environment="PATH=$node_bin:/usr/local/bin:/usr/bin:/bin"
Restart=on-failure
RestartSec=5
EOF
  systemctl --user daemon-reload
}

refresh() {
  local tgz=${1:-}
  systemctl --user stop "$unit" 2>/dev/null || true
  mkdir -p "$dir"
  rm -rf "$dir/data" "$dir/npm"
  mkdir -p "$dir/data/plugins"
  if [ -n "$tgz" ]; then
    npm install -g --allow-scripts=better-sqlite3,node-pty,@parcel/watcher --prefix "$dir/npm" "$tgz" > "$dir/npm-install.log" 2>&1 || { tail -20 "$dir/npm-install.log"; exit 1; }
  else
    cp -a "$live/npm" "$dir/npm"
  fi
  (cd "$dir/npm/lib/node_modules/sandy-app" && node -e '
const D=require("better-sqlite3");
new D(process.argv[1],{readonly:true}).backup(process.argv[2],{progress:()=>2147483647}).then(()=>{
  const db=new D(process.argv[2]);
  const off=process.argv[3].split(" ");
  const r=db.prepare("update plugins set enabled=0 where id in ("+off.map(()=>"?").join(",")+")").run(...off);
  console.log("db copied, "+r.changes+" plugins with outside effects disabled");
},e=>{console.error(e);process.exit(1)})' "$live/sandy.db" "$dir/data/sandy.db" "$side_effect_plugins")
  for f in config.json auth-secret auth.json host-id telemetry-id theme; do
    if [ -e "$live/$f" ]; then cp -a "$live/$f" "$dir/data/"; fi
  done
  (cd "$live/plugins" && tar --exclude='./*/host-data' --exclude='./*/logs' -cf - .) | (cd "$dir/data/plugins" && tar -xf -)
  SANDY_DATA_DIR="$dir/data" "$dir/npm/bin/sandy-app" config set SANDY_APP_URL "$(tailnet_url)" > /dev/null
  node -e 'const f=process.argv[1];const j=require(f);j.serverUrl="http://127.0.0.1:"+process.argv[2];require("fs").writeFileSync(f,JSON.stringify(j,null,2)+"\n")' "$dir/data/config.json" "$port"
  tailscale serve --bg --https="$port" "http://127.0.0.1:$port" > /dev/null 2>&1 || sudo -n tailscale serve --bg --https="$port" "http://127.0.0.1:$port" > /dev/null 2>&1 || echo "tailnet serve not set: run once: sudo tailscale serve --bg --https=$port http://127.0.0.1:$port"
  write_unit
  systemctl --user start "$unit"
  wait_healthy
}

wait_healthy() {
  local code=000
  for _ in $(seq 1 90); do
    sleep 2
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/health" || true)
    [ "$code" = 200 ] && break
  done
  echo "staging health: $code at $(tailnet_url)"
  [ "$code" = 200 ]
}

cmd=${1:-status}; shift || true
case "$cmd" in
  refresh) refresh "$@" ;;
  start) write_unit; systemctl --user start "$unit"; wait_healthy ;;
  stop) systemctl --user stop "$unit" ;;
  status) systemctl --user --no-pager status "$unit" | head -5; echo "url: $(tailnet_url)" ;;
  logs) ls -t "$dir/data/logs"/server*.log | head -1 | xargs tail -n "${1:-50}" ;;
  *) echo "Unknown command: $cmd" >&2; exit 1 ;;
esac
