#!/usr/bin/env node
import { askJev, fail, readStdinJson } from "./lib/jev.mjs";
import { QUESTIONS, gatherEvidence, preVerdict, verdictFrom } from "./lib/judge.mjs";

const req = readStdinJson();
const evidence = await gatherEvidence(req);
const early = preVerdict(evidence);
if (early) {
  process.stdout.write(`${JSON.stringify(early)}\n`);
  process.exit(0);
}
askJev(evidence, QUESTIONS)
  .then((answers) => process.stdout.write(`${JSON.stringify(verdictFrom(answers))}\n`))
  .catch((e) => fail("ralph-jev-judge", e));
