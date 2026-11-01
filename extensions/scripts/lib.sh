# sandy lives in ~/.local/bin (or ~/.sandy/bin), which a non-interactive ssh shell often has no PATH entry for.
sandy_on_path() {
  command -v sandy >/dev/null 2>&1 && return 0
  local d
  for d in "${SANDY_CLI:+$(dirname "${SANDY_CLI}")}" "$HOME/.local/bin" "$HOME/.sandy/bin"; do
    [ -n "$d" ] && [ -x "$d/sandy" ] && { PATH="$d:$PATH"; export PATH; return 0; }
  done
  echo "sandy not found on PATH, in ~/.local/bin or in ~/.sandy/bin" >&2
  return 1
}
