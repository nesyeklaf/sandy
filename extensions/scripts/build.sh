#!/usr/bin/env bash
# Install dependencies and build every unit (or the named ones). Run it on the host that runs the code:
# the laptop for pi extensions, the SANDY server host for SANDY plugins.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
. "$root/scripts/lib.sh"
units=("$@")
[ ${#units[@]} -gt 0 ] || units=($(ls -d sandy/*/ pi/*/ | sed 's:/$::'))
for u in "${units[@]}"; do
  [ -f "$u/package.json" ] || continue
  echo "== $u"
  (cd "$u"
   if [ -f bun.lock ]; then [ -d node_modules ] || bun install --frozen-lockfile; elif [ -f package-lock.json ]; then [ -d node_modules ] || npm ci --no-audit --no-fund; fi
   [ -f gen.mjs ] && npm run -s gen
   [ -f bun.lock ] && bun run build
   case "$u" in
     sandy/*) sandy_on_path && sandy plugin build . ;;
     pi/work) node -e 'require.resolve("@markdoc/markdoc", { paths: [process.argv[1]] })' "$root/../packages/skill-dialect" 2>/dev/null ||
       (cd "$root/.." && pnpm install --frozen-lockfile --ignore-scripts --filter @sandy/skill-dialect) ;;
   esac)
done
