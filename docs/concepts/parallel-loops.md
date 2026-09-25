# Parallel loops

When a loop is already running in a repository and you start another one, the new loop runs in a git worktree under `.worktrees/<loop-id>` on its own branch. The primary loop holds `.ralph/loop.lock` in the main repository; worktree loops don't take the lock and are registered in the main repository's `.ralph/loops.json`.

## Objective per loop

Each loop writes its full objective to `.ralph/current-objective.md` inside its own workspace: the repository root for the primary loop, the worktree for a parallel one. The Jev hooks receive the loop's workspace, id and repository root in their payload and read that file first (triage sends the first 4,000 characters to Jev, the stall check the first 2,000). So a worktree loop is triaged and watched against its own objective, not the primary loop's lock or a `PROMPT.md` that belongs to someone else.

For binaries built before this marker existed, the hooks fall back to the loop's entry in `.ralph/loops.json` (a summary of the objective) before `PROMPT.md`.

## Judging

The completion judge gets the objective directly from the loop, so it always sees the full text, in any workspace. The gauntlet's champion ref includes the loop id, so parallel loops never compare against each other's best attempt.

## Commands

```bash
ralph-jev-gauntlet loops          # list, inspect and manage parallel loops
ralph-jev-gauntlet loops --help
```
