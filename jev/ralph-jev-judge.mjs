#!/usr/bin/env node
import { askJev, fail, readStdinJson } from "./lib/jev.mjs";
import { QUESTIONS, gatherEvidence, verdictFrom } from "./lib/judge.mjs";

const req = readStdinJson();
askJev(gatherEvidence(req), QUESTIONS)
  .then((answers) => process.stdout.write(`${JSON.stringify(verdictFrom(answers))}\n`))
  .catch((e) => fail("ralph-jev-judge", e));
