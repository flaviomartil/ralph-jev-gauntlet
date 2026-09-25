# ralph-jev-gauntlet

An autonomous agent loop that only ends when a separate critic agent approves the work in a blind comparison.

ralph-jev-gauntlet runs your coding agent (Claude Code, Codex, Gemini CLI, Kiro and others) in a loop, with a fresh context on every iteration. State lives on disk and in git: events, tasks, memories and the objective. It is inspired by the Ralph loop technique (`while :; do cat PROMPT.md | agent; done`).

The difference is who decides that the work is finished. The agent can only *claim* completion. A cheap Jev screen and then a separate critic agent, comparing attempts blind, decide whether the claim holds, and the loop keeps going with the reason whenever it doesn't.

![Architecture](architecture/architecture.png)

## Where to go next

| Page | What it covers |
|---|---|
| [Getting started](getting-started.md) | Install, credentials and a first run |
| [Loop lifecycle](concepts/loop-lifecycle.md) | What happens from `run` to `LOOP_COMPLETE` |
| [Gauntlet gate](concepts/gauntlet.md) | How completion is judged |
| [Judge evidence](concepts/judge-evidence.md) | What the judge looks at and what reaches Jev |
| [Jev hooks](concepts/jev-hooks.md) | Triage at start and the stall watchdog |
| [Parallel loops](concepts/parallel-loops.md) | Worktree loops and how each one keeps its own objective |
| [Configuration](guide/configuration.md) | Config layers, judge settings, hooks and environment |
| [Troubleshooting](reference/troubleshooting.md) | Common errors and fixes |
| [Testing](development/testing.md) | How the project is tested |
| [Architecture diagrams](architecture/index.md) | Interactive Archify diagrams |
