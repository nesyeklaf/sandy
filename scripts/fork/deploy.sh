#!/usr/bin/env bash
# Deploy a sandy-app tarball to a sandy server over ssh and verify it.
# Usage: scripts/fork/deploy.sh <ssh-host> <sandy-app-x.y.z.tgz> [--force] [--skip-upgrade-test]
# The remote side runs scripts/fork/remote.sh deploy as a transient systemd unit,
# so it survives the ssh session dropping when the server restarts.
set -euo pipefail

case "${1:-}" in
  -h|--help|"") sed -n 2,5p "$0" | sed 's/^# //'; [ -n "${1:-}" ]; exit $? ;;
esac
host=$1
tgz=$2
shift 2
flags="$*"
here=$(cd "$(dirname "$0")" && pwd)
remote_tgz=/tmp/sandy-app-fork.tgz

local_sum=$(sha256sum "$tgz" | cut -d' ' -f1)
scp "$tgz" "$host:$remote_tgz"
scp "$here/remote.sh" "$host:sandy-fork-remote.sh"
remote_sum=$(ssh "$host" "sha256sum $remote_tgz" | cut -d' ' -f1)
[ "$local_sum" = "$remote_sum" ] || { echo "Checksum mismatch after copy" >&2; exit 1; }

ssh "$host" "systemd-run --user --unit=sandy-fork-deploy --collect --setenv=SANDY_DEPLOY_SELF_THREAD=${SANDY_THREAD_ID:-} bash \$HOME/sandy-fork-remote.sh deploy $remote_tgz $flags"

echo "Waiting for the deploy unit to finish..."
for _ in $(seq 1 120); do
  sleep 5
  state=$(ssh "$host" 'systemctl --user is-active sandy-fork-deploy 2>/dev/null' || true)
  [ "$state" = active ] || [ "$state" = activating ] || break
done
ssh "$host" 'bash $HOME/sandy-fork-remote.sh status'
