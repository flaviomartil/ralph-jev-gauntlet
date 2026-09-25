# Ralph Docs Page Map

The doc index is `docs/index.md` in the ralph-jev-gauntlet repo. There is no
published docs site and no llms.txt — this file keeps its historical name so
existing links keep working, but it maps topics to the pages that actually
exist in the repository.

This file is a **routing shortcut** — given a user question or bug report, it
tells you which 1–3 pages to read. Read from the local checkout when one is
available; otherwise fetch from
`https://github.com/flaviomartil/ralph-jev-gauntlet/blob/main/<path>`.

## The Complete Page List

These are the only documentation pages. Anything not derived from this list
does not exist:

- `docs/index.md` — project overview and the "Where to go next" table
- `docs/getting-started.md` — install, credentials, first run
- `docs/concepts/loop-lifecycle.md` — what happens from `run` to
  `LOOP_COMPLETE`
- `docs/concepts/gauntlet.md` — how completion is judged
- `docs/concepts/judge-evidence.md` — what the judge looks at and what
  reaches Jev
- `docs/concepts/jev-hooks.md` — triage at start and the stall watchdog
- `docs/concepts/parallel-loops.md` — worktree loops and per-loop objectives
- `docs/guide/configuration.md` — config layers, judge settings, hooks,
  environment
- `docs/reference/troubleshooting.md` — common errors and fixes
- `docs/development/testing.md` — how the project is tested
- `docs/architecture/index.md` — interactive Archify diagrams

## Question → Page Map

### Onboarding

- "How do I install / run my first loop?" → `docs/getting-started.md`
- "What is ralph-jev-gauntlet?" → `docs/index.md`

### Loop behavior

- "Why did my loop terminate?" → `docs/reference/troubleshooting.md` +
  `docs/concepts/loop-lifecycle.md`
- "What happens each iteration?" → `docs/concepts/loop-lifecycle.md`

### Completion judging (gauntlet)

- "How does Ralph decide the work is done?" → `docs/concepts/gauntlet.md`
- "Why did the judge reject the completion claim?" →
  `docs/concepts/gauntlet.md` + `docs/concepts/judge-evidence.md`
- "What evidence does the judge see?" → `docs/concepts/judge-evidence.md`
- "What is the Jev screen / triage / stall watchdog?" →
  `docs/concepts/jev-hooks.md`

### Parallel loops

- "How do worktree loops and the merge queue work?" →
  `docs/concepts/parallel-loops.md`

### Configuration

- "Which config knob controls X?" → `docs/guide/configuration.md`
- Judge settings, hooks, environment variables →
  `docs/guide/configuration.md`

### Errors

- Any error message or failure mode → `docs/reference/troubleshooting.md`

### Development

- "How is the project tested?" → `docs/development/testing.md`
- "What does the architecture look like?" → `docs/architecture/index.md`

## Topics The Docs Do Not Cover

The docs do not cover hats, the event system, preset authoring, or a CLI
reference. For those, fall back to the source and say so:

- **Hats and events** → `crates/ralph-core/src/hatless_ralph.rs` and
  `crates/ralph-core/src/event_loop/` (file map in the repo AGENTS.md)
- **Presets** → the `presets/` directory in the repo (each YAML is
  self-describing) and `crates/ralph-core/src/preset_source.rs`
- **CLI flags and subcommands** → `crates/ralph-cli/` and the local
  `ralph --help` output
- **Jev integration details** → `jev/` in the repo

## Freshness

The pages above are the canonical source for their topic — prefer them over
README snippets elsewhere, which may lag. When a page and the local checkout
disagree, trust the checkout and note the mismatch.
