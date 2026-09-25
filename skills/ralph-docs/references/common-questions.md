# Common Ralph Introspection Recipes

Use these patterns when the user's question matches. Each recipe is:
1. Trigger — what the user said
2. Read — which doc pages to pull (from the local `docs/` or GitHub)
3. Check — what to grep or grep-equivalent in them
4. Answer shape — how to frame the reply

## "Why did my loop terminate?"

1. **Trigger**: User shares a `Loop terminated:` banner or exit code 2.
2. **Read**:
   - `docs/reference/troubleshooting.md`
   - `docs/concepts/loop-lifecycle.md` (for the termination model)
3. **Check**: look for the specific reason string (`max_iterations`,
   `max_runtime_seconds`, judge rejection, `error`). Each maps to a
   documented termination path.
4. **Answer shape**: name the termination reason, quote the doc on what it
   means, tell the user the exact config knob (in ralph.yml, see
   `docs/guide/configuration.md`) that controls it.

## "Why did the judge reject the completion claim?"

1. **Trigger**: the agent claimed completion but the loop kept going.
2. **Read**:
   - `docs/concepts/gauntlet.md`
   - `docs/concepts/judge-evidence.md`
3. **Check**: what evidence the judge saw and what the Jev screen filtered.
4. **Answer shape**: explain what the judge compared, quote the rejection
   reason, point at the config knobs in `docs/guide/configuration.md`.

## "How does Ralph decide the work is done?"

1. **Read**:
   - `docs/concepts/gauntlet.md`
2. **Answer shape**: the agent can only *claim* completion; the Jev screen
   and the blind critic comparison decide. Cite the doc.

## "How do parallel loops work?"

1. **Read**:
   - `docs/concepts/parallel-loops.md`
2. **Answer shape**: worktree isolation, per-loop objective, merge queue.
   For merge-conflict behavior, cross-check
   `crates/ralph-core/src/merge_queue.rs`.

## "Which config knob controls X?"

1. **Read**:
   - `docs/guide/configuration.md`
2. **Check**: config layers, judge settings, hooks, environment variables.
3. **Answer shape**: the knob name, the layer it lives in, and the default.
   If the knob is not documented, grep `crates/ralph-core/src/config.rs`.

## "Why is Ralph slow / stuck?"

1. **Read**:
   - `docs/reference/troubleshooting.md`
   - `docs/concepts/jev-hooks.md` (stall watchdog)
2. **Check**: stall-watchdog behavior, backend cold-start cost, diagnostic
   log path (`.ralph/diagnostics/logs/`).
3. **Answer shape**: direct them to the diagnostic log filename convention;
   cite the troubleshooting entry that matches the symptom.

## "Does Ralph support X feature?"

The generic pattern:

1. Read `docs/index.md` and scan the "Where to go next" table.
2. If a page covers it → read that page, confirm, answer yes with source.
3. If absent → the topic is not documented. Hats, events, presets, and CLI
   flags have no doc pages; confirm against the source instead:
   - hats/events → `crates/ralph-core/src/hatless_ralph.rs`,
     `crates/ralph-core/src/event_loop/`
   - presets → `presets/`
   - CLI → `crates/ralph-cli/`, `ralph --help`
4. Still unsure → say "not documented; here's where to confirm".

Do not assume features exist because "they should" — Ralph is deliberately
minimal.

## "How do I add a new backend?"

1. **Trigger**: "I want Ralph to support X model CLI".
2. **Read**: there is no backends doc page; go straight to the source:
   - `crates/ralph-adapters/src/cli_backend.rs` (backend enum, factories)
   - `crates/ralph-adapters/src/` executor types (PTY/Stdio/Acp)
3. **Check**: the backend enum, the `CliBackend` factory, executor type,
   priority-list insertion point.
4. **Answer shape**: list the crates to edit (`ralph-adapters` for the
   backend + executor, `ralph-cli/src/doctor.rs` for env-var diagnostics,
   tests). Refer the user to `references/contributing.md` for the PR
   workflow.
