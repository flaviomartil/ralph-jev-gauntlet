---
name: ralph-docs
description: Introspect, explain, and improve ralph-jev-gauntlet using the documentation shipped in its repository. Use this skill whenever the user asks questions about Ralph's behavior, wants to understand how a Ralph internal works (event loop, gauntlet gate, judge evidence, Jev hooks, parallel loops, configuration), debug an unfamiliar failure mode, or propose a code change to the ralph-jev-gauntlet repo. The skill teaches the agent to answer from the repo's docs and source before guessing, and to scope improvements through the documented architecture rather than the local checkout alone.
---

# Ralph Docs

Introspect ralph-jev-gauntlet the same way the framework expects a smart agent to
— read the documentation shipped in the repository, fetch only the pages
relevant to the question, and answer from authoritative sources.

The docs live under `docs/` in the repo. There is no published docs site and no
llms.txt; the local checkout (or the GitHub blob URLs when there is no checkout)
is the source of truth.

Use this skill to behave like an internal Ralph contributor rather than a
guess-first assistant.

## Use This Skill For

- Answering "how does Ralph do X?" questions about the loop lifecycle, the
  gauntlet gate, judge evidence, Jev hooks, parallel loops, or configuration.
- Explaining an observed behavior ("why did my loop terminate?",
  "why did the judge reject the claim?") from first principles in the docs,
  not pattern-matching.
- Proposing and scoping an improvement to the `ralph-jev-gauntlet` codebase —
  locating the right crate, the relevant concept doc, and the existing test
  surface before writing code.
- Triaging a ralph bug report: map symptoms to likely subsystem, pull in the
  concept + troubleshooting docs for that subsystem, identify the probable
  file path in the repo.
- Onboarding: answer a new user's setup/quick-start questions from the official
  Getting Started page instead of the agent's stale training data.

## Core Principle: The Repo Is The Router

1. **Discover** — read `docs/index.md`. Its "Where to go next" table lists
   every documentation page that exists.
2. **Narrow** — pick the 1–3 pages that actually answer the question using the
   topic map in `references/llms-txt-map.md`.
3. **Read** — pull only those pages. Do not read more than three pages
   speculatively; the budget should be spent on answering, not browsing.
4. **Cross-check** — for code-level claims, confirm against the source (crate
   paths are listed in AGENTS.md / CLAUDE.md inside the ralph-jev-gauntlet
   checkout).
5. **Answer** — cite the page you relied on. Include the path or URL so the
   user can verify.

## Workflow

1. Identify the question's subsystem using the taxonomy in
   `references/llms-txt-map.md` (loop lifecycle, gauntlet, judge evidence,
   Jev hooks, parallel loops, configuration, troubleshooting, testing).
2. Locate the docs. Prefer a local checkout of ralph-jev-gauntlet when one is
   available; read the pages directly from its `docs/` directory. When there
   is no checkout, fetch them from GitHub:

   ```text
   https://github.com/flaviomartil/ralph-jev-gauntlet/blob/main/<path>
   ```

   for example `.../blob/main/docs/concepts/gauntlet.md`.
3. Read just those pages and answer the user's question grounded in what you
   just read. Quote the relevant sentence when the user asks "does Ralph do
   X?" so they can audit.
4. When the docs do not cover the topic (hats, events, presets, CLI
   reference), fall back to the source: `crates/` and `jev/` in the repo (the
   AGENTS.md file map points at the key files) and `presets/` for preset
   questions. Say that the docs do not cover it instead of inventing an answer.
5. If the answer requires a code change, switch to the ralph-jev-gauntlet
   checkout and follow `references/contributing.md` for the propose-a-change
   workflow.

## Scope Boundaries

- This skill answers and explains. For creating/modifying user hats, defer to
  **ralph-hats**. For operating a live loop (running, resuming, merging,
  debugging), defer to **ralph-loop**. For code changes to
  ralph-jev-gauntlet itself, this skill scopes the change; the actual editing
  uses the agent's native code-editing tools.
- Do not invent features not present in the docs or the source. If neither
  surfaces an answer, say so and point at the source tree at
  <https://github.com/flaviomartil/ralph-jev-gauntlet>.
- Do not rely on the agent's pretraining for version-sensitive claims (e.g.
  CLI flags, preset names). Ralph's CLI evolves; always verify against the
  source (`crates/ralph-cli/`) or the local `ralph --help` output.

## Guardrails

- Prefer the local checkout over GitHub fetches; it matches the version the
  user actually runs.
- When docs contradict the local checkout (docs newer than the user's
  installed ralph version), note the mismatch and suggest `ralph --version` so
  the user can decide which to trust.
- Never cite a doc page that is not listed in `references/llms-txt-map.md`;
  if a page is not there, it does not exist.

## Output Expectations

- Answer first, then link. Don't make the user wait for a verbose tour.
- Include at least one source path or URL for non-trivial claims.
- When proposing a code change, name the crate + file (see
  `references/contributing.md` for the crate map), the concept doc that
  justifies the change, and the test file that should cover it.

## Read These References When Needed

- For the doc page map + which pages answer which question:
  `references/llms-txt-map.md`
- For FAQ recipes (common introspection patterns):
  `references/common-questions.md`
- For how to propose a code change, including crate layout and PR conventions:
  `references/contributing.md`
