#!/usr/bin/env bash
# Build a release of this fork from a clean checkout of main: run the checks, build the artifacts.
# Usage: scripts/fork/release.sh [test|build|all]   (default: all)
# Artifacts go to $SANDY_FORK_DIST/<short-sha>/ (default ~/sandy-fork-dist).
set -euo pipefail

case "${1:-all}" in
  -h|--help) sed -n 2,4p "$0" | sed 's/^# //'; exit 0 ;;
esac

root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
cd "$root"
dist_root="${SANDY_FORK_DIST:-$HOME/sandy-fork-dist}"

require_clean_main() {
  [ -z "$(git status --porcelain)" ] || { echo "Working tree not clean" >&2; exit 1; }
  [ "$(git symbolic-ref --short -q HEAD || true)" = main ] || { echo "HEAD is not the main branch" >&2; exit 1; }
}

test_fork() {
  pnpm install --frozen-lockfile
  (cd apps/app && pnpm typecheck && npx vitest run src/components/ui src/components/secondary-panel)
}

find_jdk17() {
  if [ -n "${JAVA_HOME:-}" ] && "$JAVA_HOME/bin/javac" -version 2>&1 | grep -q ' 17\.'; then
    echo "$JAVA_HOME"; return
  fi
  for d in "$HOME"/.gradle/jdks/*17* /usr/lib/jvm/*17*; do
    [ -x "$d/bin/javac" ] && { echo "$d"; return; }
  done
  echo "No JDK 17 with javac found; set JAVA_HOME" >&2; exit 1
}

build() {
  local sha out
  require_clean_main
  sha=$(git rev-parse --short main)
  out="$dist_root/$sha"
  mkdir -p "$out"

  pnpm --filter @sandy/desktop run prepare-runtime
  pnpm --filter @sandy/desktop run desktop:build:linux
  cp apps/desktop/release/*.AppImage "$out/"

  (cd packages/sandy-app && npm pack --pack-destination "$out")

  (
    export JAVA_HOME; JAVA_HOME=$(find_jdk17)
    export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
    export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
    cd apps/mobile && bash scripts/build-android-local.sh arm64-v8a production
  )
  cp apps/mobile/build-output/sandy-android-local.apk "$out/sandy-android-$sha.apk"

  (cd "$out" && sha256sum -- * > SHA256SUMS)
  echo "Artifacts in $out"
  cat "$out/SHA256SUMS"
}

case "${1:-all}" in
  test) test_fork ;;
  build) build ;;
  all) require_clean_main; test_fork; build ;;
  *) echo "Usage: $0 [test|build|all]" >&2; exit 1 ;;
esac
