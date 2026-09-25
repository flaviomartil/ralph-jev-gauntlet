# ralph-jev-gauntlet Agent Skills

This directory is the canonical public skill package for external agent
harnesses that operate Ralph.

It ships three skills:

- `ralph-hats` for creating, inspecting, validating, and improving hat
  collections
- `ralph-loop` for running, monitoring, resuming, merging, and debugging Ralph
  loops
- `ralph-docs` for introspecting and improving Ralph itself via the
  documentation in this repository — answering "how does Ralph do X?"
  questions and scoping code changes to the ralph-jev-gauntlet repo

These are public agent skills. They are not part of Ralph's internal
`ralph tools skill` registry.

## Install with Claude Code

Add this repository as a marketplace source:

```text
/plugin marketplace add flaviomartil/ralph-jev-gauntlet
```

Then install the `ralph-jev-gauntlet` plugin from the marketplace browser.

## Install with Vercel `npx skills`

List the skills in this repository:

```bash
npx skills add flaviomartil/ralph-jev-gauntlet --list
```

Install all skills for Claude Code:

```bash
npx skills add flaviomartil/ralph-jev-gauntlet \
  --skill ralph-hats \
  --skill ralph-loop \
  --skill ralph-docs \
  -a claude-code \
  -y
```

Install one skill for Codex-style agents:

```bash
npx skills add flaviomartil/ralph-jev-gauntlet \
  --skill ralph-loop \
  -a codex \
  -y
```

During local development you can also install from the checked-out repo:

```bash
npx skills add . --list
```
