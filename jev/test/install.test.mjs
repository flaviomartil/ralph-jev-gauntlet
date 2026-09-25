import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { scratchDir } from "./helpers.mjs";

const INSTALL = join(dirname(fileURLToPath(import.meta.url)), "..", "install.sh");
const wrapperLine = readFileSync(INSTALL, "utf8")
  .split("\n")
  .find((line) => line.startsWith("printf '#!/usr/bin/env bash"));

function makeWrapper(cfg, bin, out) {
  execFileSync("bash", ["-c", `set -euo pipefail; GAUNTLET_CFG="$1"; RALPH_BIN="$2"; BIN_DIR="$3"; ${wrapperLine}`, "gen", cfg, bin, out]);
  const wrapper = join(out, "ralph-jev-gauntlet");
  chmodSync(wrapper, 0o755);
  return wrapper;
}

function fakeBin(dir, name) {
  const bin = join(dir, name);
  writeFileSync(bin, '#!/usr/bin/env bash\nprintf "%s\\n" "$RALPH_USER_CONFIG" "$#" "$@"\n');
  chmodSync(bin, 0o755);
  return bin;
}

test("install.sh has a wrapper line", () => {
  assert.ok(wrapperLine);
});

for (const [label, cfgName, binName] of [
  ["plain paths", "gauntlet.yml", "ralph"],
  ["spaces", "my cfg.yml", "ralph bin"],
  ["quotes", "it's \"cfg\".yml", "ral'ph"],
  ["command substitution", "$(touch PWNED).yml", "bin`touch PWNED`"],
  ["globs and variables", "*.yml $HOME", "r[a]lph ${HOME}"],
]) {
  test(`wrapper keeps paths intact with ${label}`, () => {
    const dir = scratchDir("wrap");
    const out = join(dir, "bin");
    mkdirSync(out);
    const cfg = join(dir, cfgName);
    const wrapper = makeWrapper(cfg, fakeBin(dir, binName), out);
    const env = { ...process.env };
    delete env.RALPH_USER_CONFIG;
    const lines = execFileSync(wrapper, ["a", "b c"], { cwd: dir, env, encoding: "utf8" }).split("\n");
    assert.deepEqual(lines.slice(0, 4), [cfg, "2", "a", "b c"]);
    assert.equal(existsSync(join(dir, "PWNED")), false);
  });
}

test("wrapper keeps a RALPH_USER_CONFIG that is already set", () => {
  const dir = scratchDir("wrap");
  const out = join(dir, "bin");
  mkdirSync(out);
  const wrapper = makeWrapper(join(dir, "g.yml"), fakeBin(dir, "ralph"), out);
  const out1 = execFileSync(wrapper, [], { env: { ...process.env, RALPH_USER_CONFIG: "/custom/cfg.yml" }, encoding: "utf8" });
  assert.equal(out1.split("\n")[0], "/custom/cfg.yml");
});
