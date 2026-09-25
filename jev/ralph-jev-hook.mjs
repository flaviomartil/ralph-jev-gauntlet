#!/usr/bin/env node
import { askJev, fail, readStdinJson } from "./lib/jev.mjs";
import { MODES } from "./lib/hooks.mjs";

const mode = MODES[process.argv[2]];
if (!mode) {
  process.stderr.write(`usage: ralph-jev-hook <${Object.keys(MODES).join("|")}>\n`);
  process.exit(64);
}

const payload = readStdinJson();
const ws = payload.loop?.workspace || process.cwd();

if (mode.skip?.(payload)) {
  process.stdout.write(`${JSON.stringify({ metadata: { skipped: true } })}\n`);
  process.exit(0);
}

const state = mode.state(payload, ws);
askJev(state, mode.questions)
  .then((answers) => {
    const { metadata, warnings, blocking } = mode.decide(answers, state);
    for (const w of warnings) process.stderr.write(`ralph-jev ${process.argv[2]}: ${w}\n`);
    process.stdout.write(`${JSON.stringify({ metadata })}\n`);
    process.exit(blocking ? 1 : 0);
  })
  .catch((e) => fail(`ralph-jev-hook ${process.argv[2]}`, e));
