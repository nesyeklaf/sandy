#!/usr/bin/env bash
# Fail when tracked files still name a forbidden external host or URL.
# Usage: scripts/fork/check-egress-hosts.sh
# Forbidden patterns live in FORBIDDEN below; allowed leftovers live in egress-exceptions.tsv (path prefix, reason).
set -euo pipefail

root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
cd "$root"
exceptions="$root/scripts/fork/egress-exceptions.tsv"

FORBIDDEN='posthog|nesyeklaf/sandy/releases|exp\.host|\bskills\.sh\b|modal\.com|getbb\.app'

pathspec=(. ':!pnpm-lock.yaml' ':!scripts/fork/check-egress-hosts.sh' ':!scripts/fork/egress-exceptions.tsv')
while IFS=$'\t' read -r prefix _reason; do
  case "$prefix" in ''|'#'*) continue ;; esac
  pathspec+=(":!$prefix")
done < "$exceptions"

hits=$(git grep -nIiE "$FORBIDDEN" -- "${pathspec[@]}" | cut -c1-200 || true)
if [ -n "$hits" ]; then
  echo "Forbidden external hosts found:" >&2
  echo "$hits" >&2
  echo "Delete them from source, or list the path with a reason in scripts/fork/egress-exceptions.tsv." >&2
  exit 1
fi
echo "check-egress-hosts: no forbidden hosts outside the listed exceptions"
