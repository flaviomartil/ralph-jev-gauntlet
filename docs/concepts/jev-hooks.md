# Jev hooks

Besides the completion gate, Jev runs at two lifecycle events through `ralph-jev-hook <triage|progress>`.

| Point | Event | Jev questions | Warns when |
|---|---|---|---|
| Triage | `pre.loop.start` | `difficulty` (score 0 to 3), `ambiguous` (noul) | `max_iterations` is below the suggestion for the difficulty (5, 15, 40, 100), or `ambiguous` is at least `RALPH_JEV_AMBIGUOUS_THRESHOLD` (0.7) |
| Progress | `pre.iteration.start` | `stalled` (noul) | `stalled` is at least `RALPH_JEV_STALL_THRESHOLD` (0.75) |

The progress check starts at iteration `RALPH_JEV_PROGRESS_MIN_ITERATION` (default 3).

## Output

Each hook prints its scores as hook metadata on stdout (`{"metadata": {...}}`), writes warnings to stderr, and exits non-zero when its threshold is crossed. The hook's `on_error` decides what that means:

| `on_error` | Effect |
|---|---|
| `warn` (default in the presets) | Log the warning and keep going |
| `block` | Stop the loop |
| `suspend` | Pause the loop until resumed |

## When Jev is unavailable

If Jev is unreachable, rate limited, or returns an incomplete answer, the hooks print `Jev unavailable ... skipping` and exit 0, so an outage never blocks a loop even with `on_error: block`.

## Which objective the hooks read

The hooks read the objective from the first of these that exists:

1. `.ralph/current-objective.md` in the loop's workspace (written by the loop at start, full text).
2. `.ralph/loop.lock` in the workspace (100 character summary, primary loop only).
3. The loop's entry in the main repository's `.ralph/loops.json` (worktree loops, summary).
4. `PROMPT.md`.

See [Parallel loops](parallel-loops.md) for why this matters.
