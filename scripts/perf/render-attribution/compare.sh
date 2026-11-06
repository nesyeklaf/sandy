#!/usr/bin/env bash
set -euo pipefail

usage="usage: compare.sh <work-dir> <out-dir> <rounds> <sidebar-delegate-dist> <name>=<commit>..."
WORK=${1:?$usage}
OUT=${2:?$usage}
ROUNDS=${3:?$usage}
DELEGATE=${4:?$usage}
shift 4
[ $# -ge 2 ] || { echo "$usage"; exit 2; }
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
mkdir -p "$WORK" "$OUT/run"
WORK=$(cd "$WORK" && pwd)
OUT=$(cd "$OUT" && pwd)
DELEGATE=$(cd "$DELEGATE" && pwd)

labs=()
variants=()
trees=()
cleanup() {
  for tree in "${trees[@]}"; do git -C "$REPO" worktree remove --force "$tree" || true; done
}
trap cleanup EXIT

for entry in "$@"; do
  name=${entry%%=*}
  commit=${entry#*=}
  tree="$WORK/src-$name"
  rm -rf "$tree"
  git -C "$REPO" worktree add --detach "$tree" "$commit" > "$WORK/worktree-$name.log" 2>&1
  trees+=("$tree")
  (cd "$tree" && pnpm install --frozen-lockfile --prefer-offline) > "$WORK/install-$name.log" 2>&1
  RA_ROOT="$tree" RA_BUILD_ONLY=1 "$HERE/run.sh" "$WORK/lab-$name" "$OUT" "$ROUNDS" "$DELEGATE"
  git -C "$tree" rev-parse HEAD > "$WORK/lab-$name/commit"
  labs+=("$name=$WORK/lab-$name")
  variants+=("$name:prod~bare" "$name:prod")
done

join() { local IFS=,; echo "$*"; }
timeout 7200 flock /tmp/staging-lab.lock node "$HERE/rounds.mjs" --labs "$(join "${labs[@]}")" --variants "$(join "${variants[@]}")" --out "$OUT/run" --rounds "$ROUNDS" 2>&1 | tee "$OUT/run/rounds.log"
node "$HERE/compare.mjs" --run "$OUT/run" --out "$OUT"
