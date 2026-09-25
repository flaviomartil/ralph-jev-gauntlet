# Getting started

## Requirements

Rust (edition 2024), Node.js 18+, git, a builder agent CLI, and a critic CLI (`claude` or `codex`). A TypeSafe API key for Jev.

## Install

```bash
git clone https://github.com/flaviomartil/ralph-jev-gauntlet.git
cd ralph-jev-gauntlet
jev/install.sh
```

The installer builds the release binary and writes a small `ralph-jev-gauntlet` wrapper into `~/.local/bin`. The wrapper sets `RALPH_USER_CONFIG` to `~/.ralph/gauntlet.yml` (unless you already set it), so the gauntlet has its own user config and can live next to `ralph-jev`, which keeps using `~/.ralph/config.yml`. It also links `ralph-gauntlet-judge`, `ralph-jev-judge` and `ralph-jev-hook`, and creates `~/.ralph/gauntlet.yml` from `jev/ralph.gauntlet.yml` if it doesn't exist.

Set `CARGO_TARGET_DIR` before running the installer to build somewhere else (for example on a bigger disk). `BIN_DIR` changes where the commands go.

## Jev credentials

Set `TYPESAFE_API_KEY` in your environment, or keep it in `~/.config/jev-browser-use/.env` as `TYPESAFE_API_KEY=...`. Without a key the hooks skip and the judge fails open (see [Configuration](guide/configuration.md)).

## First run

Check the environment first:

```bash
ralph-jev-gauntlet doctor
ralph-jev-gauntlet hooks validate
```

Then give the loop an objective with a checkable definition of done:

```bash
ralph-jev-gauntlet run -p "$(cat <<'EOF'
Add a header before the <p> tag.

## Acceptance criteria
- An <h1> header appears before the <p> tag in index.html
- A test script verifies the header order and passes
EOF
)" --max-iterations 30
```

Useful while it runs:

- `RALPH_JEV_VERIFY_CMD="npm test"` makes the judge run your tests before asking Jev.
- `ralph-jev-gauntlet events` shows the event history, including judge rejections.
- `.ralph/current-objective.md` holds the full objective the hooks are reading.
