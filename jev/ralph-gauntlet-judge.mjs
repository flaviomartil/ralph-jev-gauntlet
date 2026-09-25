#!/usr/bin/env node
import { readStdinJson } from "./lib/jev.mjs";
import { log, runGauntlet } from "./lib/gauntlet-run.mjs";

runGauntlet(readStdinJson())
  .then((verdict) => process.stdout.write(`${JSON.stringify(verdict)}\n`))
  .catch((e) => {
    log(e.message);
    process.exit(1);
  });
