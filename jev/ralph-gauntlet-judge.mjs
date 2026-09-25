#!/usr/bin/env node
import { readStdinJson } from "./lib/jev.mjs";
import { cleanupActive, log, runGauntlet } from "./lib/gauntlet-run.mjs";

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {
    cleanupActive();
    process.exit(128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 })[signal]);
  });
}

runGauntlet(readStdinJson())
  .then((verdict) => process.stdout.write(`${JSON.stringify(verdict)}\n`))
  .catch((e) => {
    log(e.message);
    process.exit(1);
  });
