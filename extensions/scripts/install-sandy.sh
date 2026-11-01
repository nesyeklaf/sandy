#!/usr/bin/env bash
# Install (or switch the source of) the SANDY plugins to this checkout. Run it with a sandy CLI that talks to the
# SANDY server; the server resolves the path, so this checkout must live on the server host. Settings of an
# already installed plugin stay: sandy switches a local path source when the same plugin is installed from a new path.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
. "$root/scripts/lib.sh"
sandy_on_path
for u in "${@:-genui permissions personas pi-lifecycle work}"; do
  for n in $u; do
    echo "== $n"
    sandy plugin install "$root/sandy/$n" --yes
  done
done
