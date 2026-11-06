#!/usr/bin/env bash
set -euo pipefail

usage="usage: run.sh <lab-dir> <out-dir> [rounds] [sidebar-delegate-dist]"
LAB=${1:?$usage}
OUT=${2:?$usage}
ROUNDS=${3:-8}
DELEGATE=${4:-}
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
HERE="$ROOT/scripts/perf/render-attribution"
mkdir -p "$LAB" "$OUT/run"
LAB=$(cd "$LAB" && pwd)
OUT=$(cd "$OUT" && pwd)

if [ -n "$DELEGATE" ]; then
  rm -rf "$LAB/sidebar-delegate"
  cp -r "$DELEGATE" "$LAB/sidebar-delegate"
fi
[ -f "$LAB/sidebar-delegate/app.js" ] || { echo "missing $LAB/sidebar-delegate/app.js (pass the sandy-sidebar-delegate dist dir)"; exit 2; }

cd "$ROOT"
pnpm exec turbo run build --filter=@sandy/app^... > "$LAB/build-deps.log" 2>&1
for plugin in extensions/sandy/genui; do
  [ -d "$plugin/node_modules" ] || (cd "$plugin" && npm ci --ignore-scripts --no-audit --no-fund) >> "$LAB/build-plugin-deps.log" 2>&1
done
(
  cd apps/app
  node scripts/generate-pwa-icons.mjs
  npx vite build --outDir "$LAB/host-prod" --emptyOutDir --sourcemap hidden
  pnpm run build:profiling
  rm -rf "$LAB/host-profiling"
  cp -r dist-profiling "$LAB/host-profiling"
) > "$LAB/build-host.log" 2>&1
node --import tsx "$HERE/build-genui.ts" extensions/sandy/genui "$LAB/genui" 0.49.0 > "$LAB/build-genui.log" 2>&1
node --import tsx "$HERE/build-genui.ts" extensions/sandy/genui "$LAB/genui-unminified" 0.49.0 no-minify >> "$LAB/build-genui.log" 2>&1

timeout 4000 flock /tmp/staging-lab.lock node "$HERE/rounds.mjs" --lab "$LAB" --out "$OUT/run" --rounds "$ROUNDS" 2>&1 | tee "$OUT/run/rounds.log"
node "$HERE/report.mjs" --run "$OUT/run" --out "$OUT"
