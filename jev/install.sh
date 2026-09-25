#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
USER_CFG="$HOME/.ralph/config.yml"

cargo build --release -p ralph-cli --manifest-path "$ROOT/Cargo.toml"
mkdir -p "$BIN_DIR"
ln -sf "${CARGO_TARGET_DIR:-$ROOT/target}/release/ralph" "$BIN_DIR/ralph-jev-gauntlet"
ln -sf "$ROOT/jev/ralph-gauntlet-judge.mjs" "$BIN_DIR/ralph-gauntlet-judge"
ln -sf "$ROOT/jev/ralph-jev-judge.mjs" "$BIN_DIR/ralph-jev-judge"
ln -sf "$ROOT/jev/ralph-jev-hook.mjs" "$BIN_DIR/ralph-jev-hook"

if [ -f "$USER_CFG" ] && grep -q "ralph-gauntlet-judge" "$USER_CFG"; then
  echo "ralph-jev-gauntlet: gauntlet already configured in $USER_CFG"
elif [ ! -f "$USER_CFG" ]; then
  mkdir -p "$(dirname "$USER_CFG")"
  cp "$ROOT/jev/ralph.gauntlet.yml" "$USER_CFG"
  echo "ralph-jev-gauntlet: created $USER_CFG with the gauntlet judge and Jev hooks"
elif ! grep -qE "^(event_loop|hooks):" "$USER_CFG"; then
  cp "$USER_CFG" "$USER_CFG.bak.$(date +%s)"
  printf '\n' >> "$USER_CFG"
  cat "$ROOT/jev/ralph.gauntlet.yml" >> "$USER_CFG"
  echo "ralph-jev-gauntlet: appended the gauntlet judge and Jev hooks to $USER_CFG"
else
  echo "ralph-jev-gauntlet: merge jev/ralph.gauntlet.yml into $USER_CFG manually, or pass it per project in ralph.yml"
fi
