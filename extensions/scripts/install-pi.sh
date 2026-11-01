#!/usr/bin/env bash
# Link the pi extensions from this checkout into ~/.pi/agent. pi loads them from here, so a change
# reaches pi when it lands in the main checkout. An existing real file or directory is moved to
# <name>.pre-plugins-repo (never deleted); an existing symlink is replaced.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
agent="${PI_AGENT_DIR:-$HOME/.pi/agent}"
link() { # link <target in repo> <path under agent>
  local target="$root/$1" dest="$agent/$2"
  mkdir -p "$(dirname "$dest")"
  if [ -L "$dest" ]; then rm "$dest"; elif [ -e "$dest" ]; then mv "$dest" "$dest.pre-plugins-repo"; fi
  ln -s "$target" "$dest"
  echo "$dest -> $target"
}
link pi/permissions extensions/permissions
link pi/work extensions/work
link pi/work/autopilot/autopilots autopilots
# pi/work replaces these; a second copy would register the same tools and hooks twice.
for old in track-guard autopilot sandy-delegate sandy-goals; do
  dest="$agent/extensions/$old"
  if [ -L "$dest" ]; then rm "$dest"; echo "removed $dest"; elif [ -e "$dest" ]; then mv "$dest" "$agent/$old.pre-plugins-work"; echo "moved $dest aside"; fi
done
if grep -q '"[^"]*plugins/pi/goal-x"\|"npm:pi-goal-x' "$agent/settings.json" 2>/dev/null; then
  echo "WARNING: $agent/settings.json still loads pi-goal-x; remove that entry, pi/work loads goal/ itself" >&2
fi
mkdir -p "$agent/extensions/lifecycle"
link sandy/pi-lifecycle/pi-extension.ts extensions/lifecycle/index.ts
