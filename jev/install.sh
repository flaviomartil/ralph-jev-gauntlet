#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
GAUNTLET_CFG="${RALPH_GAUNTLET_CONFIG:-$HOME/.ralph/gauntlet.yml}"
RALPH_BIN="${CARGO_TARGET_DIR:-$ROOT/target}/release/ralph"
case "$RALPH_BIN" in /*) ;; *) RALPH_BIN="$PWD/$RALPH_BIN" ;; esac

cargo build --release -p ralph-cli --manifest-path "$ROOT/Cargo.toml"
mkdir -p "$BIN_DIR"
rm -f "$BIN_DIR/ralph-jev-gauntlet"
printf '#!/usr/bin/env bash\n: ${RALPH_USER_CONFIG:=%q}\nexport RALPH_USER_CONFIG\nexec %q "$@"\n' "$GAUNTLET_CFG" "$RALPH_BIN" > "$BIN_DIR/ralph-jev-gauntlet"
chmod +x "$BIN_DIR/ralph-jev-gauntlet"
ln -sf "$ROOT/jev/ralph-gauntlet-judge.mjs" "$BIN_DIR/ralph-gauntlet-judge"
ln -sf "$ROOT/jev/ralph-jev-judge.mjs" "$BIN_DIR/ralph-jev-judge"
ln -sf "$ROOT/jev/ralph-jev-hook.mjs" "$BIN_DIR/ralph-jev-hook"

if [ -f "$GAUNTLET_CFG" ] && grep -q "ralph-gauntlet-judge" "$GAUNTLET_CFG"; then
  echo "ralph-jev-gauntlet: gauntlet already configured in $GAUNTLET_CFG"
elif [ ! -f "$GAUNTLET_CFG" ]; then
  mkdir -p "$(dirname "$GAUNTLET_CFG")"
  cp "$ROOT/jev/ralph.gauntlet.yml" "$GAUNTLET_CFG"
  echo "ralph-jev-gauntlet: created $GAUNTLET_CFG with the gauntlet judge and Jev hooks"
else
  echo "ralph-jev-gauntlet: merge jev/ralph.gauntlet.yml into $GAUNTLET_CFG manually"
fi
