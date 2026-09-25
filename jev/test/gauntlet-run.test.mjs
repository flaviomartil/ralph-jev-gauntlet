import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { CHAMPION_REF, criticCommand, runGauntlet, snapshot } from "../lib/gauntlet-run.mjs";
import { git, initRepo, scratchDir } from "./helpers.mjs";

const commandCases = [
  [{}, ["claude", "-p", "--permission-mode", "bypassPermissions", "--add-dir", "/w"]],
  [{ RALPH_GAUNTLET_CRITIC: "claude" }, ["claude", "-p", "--permission-mode", "bypassPermissions", "--add-dir", "/w"]],
  [{ RALPH_GAUNTLET_CRITIC: "codex" }, ["codex", "exec", "--skip-git-repo-check", "-s", "workspace-write", "-C", "/w", "-"]],
  [{ RALPH_GAUNTLET_CRITIC_CMD: '["my-critic","--x"]' }, ["my-critic", "--x"]],
  [{ RALPH_GAUNTLET_CRITIC_CMD: '["only"]', RALPH_GAUNTLET_CRITIC: "codex" }, ["only"]],
];
for (const [env, expected] of commandCases) {
  test(`criticCommand ${JSON.stringify(env)}`, () => assert.deepEqual(criticCommand("/w", env), expected));
}

for (const bad of ["[]", '"str"', "[1]", '["a", 2]', "{}", "not json"]) {
  test(`criticCommand rejects RALPH_GAUNTLET_CRITIC_CMD=${bad}`, () => {
    assert.throws(() => criticCommand("/w", { RALPH_GAUNTLET_CRITIC_CMD: bad }));
  });
}

test("criticCommand rejects an unknown critic", () => {
  assert.throws(() => criticCommand("/w", { RALPH_GAUNTLET_CRITIC: "gpt" }), /unknown RALPH_GAUNTLET_CRITIC/);
});

function lsTree(ws, sha) {
  return git(ws, ["ls-tree", "-r", "--name-only", sha]).split("\n").filter(Boolean).sort();
}

test("snapshot includes tracked, modified and untracked files but not .ralph", () => {
  const ws = initRepo(scratchDir("snap"));
  writeFileSync(join(ws, "tracked.txt"), "v1");
  git(ws, ["add", "."]);
  git(ws, ["commit", "-q", "-m", "t"]);
  writeFileSync(join(ws, "tracked.txt"), "v2");
  writeFileSync(join(ws, "new.txt"), "n");
  mkdirSync(join(ws, ".ralph"));
  writeFileSync(join(ws, ".ralph", "state.json"), "{}");
  const work = scratchDir("work");
  const sha = snapshot(ws, work);
  assert.deepEqual(lsTree(ws, sha), ["new.txt", "tracked.txt"]);
  assert.equal(git(ws, ["show", `${sha}:tracked.txt`]), "v2");
  assert.equal(git(ws, ["rev-parse", `${sha}^`]), git(ws, ["rev-parse", "HEAD"]));
});

test("snapshot respects .gitignore", () => {
  const ws = initRepo(scratchDir("snap"));
  writeFileSync(join(ws, ".gitignore"), "build/\n");
  mkdirSync(join(ws, "build"));
  writeFileSync(join(ws, "build", "out.bin"), "x");
  writeFileSync(join(ws, "src.txt"), "s");
  assert.deepEqual(lsTree(ws, snapshot(ws, scratchDir("work"))), [".gitignore", "src.txt"]);
});

test("snapshot records deletions", () => {
  const ws = initRepo(scratchDir("snap"));
  writeFileSync(join(ws, "gone.txt"), "x");
  writeFileSync(join(ws, "kept.txt"), "y");
  git(ws, ["add", "."]);
  git(ws, ["commit", "-q", "-m", "t"]);
  git(ws, ["rm", "-q", "--cached", "gone.txt"]);
  git(ws, ["commit", "-q", "-m", "untrack"]);
  writeFileSync(join(ws, "gone.txt"), "x");
  git(ws, ["add", "gone.txt"]);
  git(ws, ["commit", "-q", "-m", "back"]);
  git(ws, ["rm", "-q", "gone.txt"]);
  assert.deepEqual(lsTree(ws, snapshot(ws, scratchDir("work"))), ["kept.txt"]);
});

test("snapshot leaves the user's index, HEAD and working tree alone", () => {
  const ws = initRepo(scratchDir("snap"));
  writeFileSync(join(ws, "staged.txt"), "s");
  writeFileSync(join(ws, "loose.txt"), "l");
  git(ws, ["add", "staged.txt"]);
  const before = { status: git(ws, ["status", "--porcelain"]), head: git(ws, ["rev-parse", "HEAD"]) };
  snapshot(ws, scratchDir("work"));
  assert.deepEqual({ status: git(ws, ["status", "--porcelain"]), head: git(ws, ["rev-parse", "HEAD"]) }, before);
});

test("snapshot works in a repository without commits", () => {
  const ws = initRepo(scratchDir("snap"), { commit: false });
  writeFileSync(join(ws, "first.txt"), "f");
  const sha = snapshot(ws, scratchDir("work"));
  assert.deepEqual(lsTree(ws, sha), ["first.txt"]);
  assert.throws(() => git(ws, ["rev-parse", "-q", "--verify", `${sha}^`]));
});

test("snapshot of an unchanged tree is stable", () => {
  const ws = initRepo(scratchDir("snap"));
  writeFileSync(join(ws, "a.txt"), "a");
  const a = snapshot(ws, scratchDir("work"));
  const b = snapshot(ws, scratchDir("work"));
  assert.equal(git(ws, ["rev-parse", `${a}^{tree}`]), git(ws, ["rev-parse", `${b}^{tree}`]));
});

const FAKE_CRITIC = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const prompt = fs.readFileSync(0, "utf8");
if (process.env.FAKE_CRITIC_LOG) fs.appendFileSync(process.env.FAKE_CRITIC_LOG, JSON.stringify({ prompt, cwd: process.cwd() }) + "\\n");
const mode = process.env.FAKE_CRITIC_MODE || "score";
if (mode === "exit") process.exit(3);
if (mode === "nojson") { console.log("looks fine to me"); process.exit(0); }
if (mode === "sleep") { setTimeout(() => {}, 60000); return; }
const dirs = {};
for (const m of prompt.matchAll(/^- Version ([AB]): (.+)$/gm)) dirs[m[1]] = m[2];
const target = Number(process.env.FAKE_TARGET || "2");
const score = {};
for (const [v, d] of Object.entries(dirs)) {
  const f = path.join(d, "app.txt");
  score[v] = fs.existsSync(f) ? Number(fs.readFileSync(f, "utf8").trim()) : 0;
  if (mode === "vandal") fs.writeFileSync(f, "999");
}
const ids = [...prompt.matchAll(/^(c\\d+)\\. /gm)].map((m) => m[1]);
const criteria = [];
for (const v of Object.keys(dirs)) for (const id of ids) criteria.push({ id, version: v, pass: score[v] >= target, evidence: "app.txt=" + score[v] });
const versions = Object.keys(dirs);
let pick = "A";
if (versions.length === 2) pick = score.A === score.B ? "tie" : score.A > score.B ? "A" : "B";
console.log("checked " + versions.join(","));
console.log(JSON.stringify({ criteria, pick, beats_bar: process.env.FAKE_BEATS_BAR === "1", defects: ["raise app.txt"] }));
`;

function setup({ objective = "Raise app.txt\n\n## Requirements\n- app.txt is at least the target\n- nothing else breaks", commit = true } = {}) {
  const root = scratchDir("run");
  const ws = join(root, "repo");
  mkdirSync(ws);
  initRepo(ws, { commit });
  const critic = join(root, "critic.cjs");
  writeFileSync(critic, FAKE_CRITIC);
  chmodSync(critic, 0o755);
  const log = join(root, "critic.log");
  const work = join(root, "work");
  mkdirSync(work);
  const env = { ...process.env, RALPH_GAUNTLET_CRITIC_CMD: JSON.stringify([critic]), RALPH_GAUNTLET_WORKDIR: work };
  return { root, ws, env, log, work, req: { objective, workspace: ws, closed_tasks: [] } };
}

function criticCalls(log) {
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

function champion(ws) {
  try {
    return git(ws, ["rev-parse", "-q", "--verify", CHAMPION_REF]);
  } catch {
    return null;
  }
}

async function withJev(answers, fn, extraEnv = {}) {
  const saved = { ...process.env };
  const original = globalThis.fetch;
  const calls = [];
  Object.assign(process.env, { TYPESAFE_API_KEY: "k", XDG_CACHE_HOME: scratchDir("cache"), ...extraEnv });
  globalThis.fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    if (answers instanceof Error) throw answers;
    if (typeof answers === "number") return { ok: false, status: answers, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ answers }) };
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
    process.env = saved;
  }
}

const JEV_OK = { c1: { noul: 0.9 }, c2: { noul: 0.9 }, verified: { noul: 0.9 } };

function sandboxEnv(ctx, vars) {
  Object.assign(process.env, { FAKE_CRITIC_LOG: ctx.log, ...vars });
}

test("runGauntlet: Jev rejection stops before the critic", async () => {
  const ctx = setup();
  writeFileSync(join(ctx.ws, "app.txt"), "5");
  await withJev({ c1: { noul: 0.1 }, c2: { noul: 0.9 }, verified: { noul: 0.9 } }, async (calls) => {
    sandboxEnv(ctx, {});
    const out = await runGauntlet(ctx.req, ctx.env);
    assert.equal(out.verdict, "fail");
    assert.match(out.reason, /^Jev: requirements not met: c1 /);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].state.criteria, ["app.txt is at least the target", "nothing else breaks"]);
  });
  assert.equal(criticCalls(ctx.log).length, 0);
  assert.equal(champion(ctx.ws), null);
});

test("runGauntlet: first passing attempt passes and becomes champion", async () => {
  const ctx = setup();
  writeFileSync(join(ctx.ws, "app.txt"), "2");
  await withJev(JEV_OK, async () => {
    sandboxEnv(ctx, {});
    const out = await runGauntlet(ctx.req, ctx.env);
    assert.equal(out.verdict, "pass", out.reason);
    assert.equal(out.reason, "critic approved 2 requirement(s)");
  });
  const calls = criticCalls(ctx.log);
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0].prompt, /Version B/);
  assert.equal(git(ctx.ws, ["show", `${champion(ctx.ws)}:app.txt`]), "2");
});

test("runGauntlet: Jev outage goes straight to the critic", async () => {
  const ctx = setup();
  writeFileSync(join(ctx.ws, "app.txt"), "3");
  await withJev(new Error("ECONNREFUSED"), async () => {
    sandboxEnv(ctx, {});
    assert.equal((await runGauntlet(ctx.req, ctx.env)).verdict, "pass");
  });
  assert.equal(criticCalls(ctx.log).length, 1);
});

test("runGauntlet: Jev quota error goes straight to the critic", async () => {
  const ctx = setup();
  writeFileSync(join(ctx.ws, "app.txt"), "3");
  await withJev(429, async () => {
    sandboxEnv(ctx, {});
    assert.equal((await runGauntlet(ctx.req, ctx.env)).verdict, "pass");
  });
  assert.equal(criticCalls(ctx.log).length, 1);
});

test("runGauntlet: failing first attempt still becomes the champion", async () => {
  const ctx = setup();
  writeFileSync(join(ctx.ws, "app.txt"), "1");
  await withJev(JEV_OK, async () => {
    sandboxEnv(ctx, {});
    const out = await runGauntlet(ctx.req, ctx.env);
    assert.equal(out.verdict, "fail");
    assert.match(out.reason, /critic: requirements failing: c1 .*app\.txt=1/);
    assert.match(out.reason, /defects: raise app\.txt/);
  });
  assert.equal(git(ctx.ws, ["show", `${champion(ctx.ws)}:app.txt`]), "1");
});

test("runGauntlet: a better attempt beats the champion blind and passes", async () => {
  const ctx = setup();
  await withJev(JEV_OK, async () => {
    sandboxEnv(ctx, {});
    writeFileSync(join(ctx.ws, "app.txt"), "1");
    await runGauntlet(ctx.req, ctx.env);
    writeFileSync(join(ctx.ws, "app.txt"), "4");
    const out = await runGauntlet(ctx.req, ctx.env);
    assert.equal(out.verdict, "pass", out.reason);
    assert.match(out.reason, /beat previous best/);
  });
  const calls = criticCalls(ctx.log);
  assert.equal(calls.length, 2);
  assert.match(calls[1].prompt, /- Version A: .*\n- Version B: /);
  assert.equal(git(ctx.ws, ["show", `${champion(ctx.ws)}:app.txt`]), "4");
});

test("runGauntlet: a regression is rejected and the champion is kept", async () => {
  const ctx = setup();
  await withJev(JEV_OK, async () => {
    sandboxEnv(ctx, { FAKE_TARGET: "3" });
    writeFileSync(join(ctx.ws, "app.txt"), "2");
    await runGauntlet(ctx.req, ctx.env);
    writeFileSync(join(ctx.ws, "app.txt"), "5");
    await runGauntlet(ctx.req, ctx.env);
    writeFileSync(join(ctx.ws, "app.txt"), "4");
    const out = await runGauntlet(ctx.req, ctx.env);
    assert.equal(out.verdict, "fail");
    assert.match(out.reason, /regressed/);
  });
  assert.equal(git(ctx.ws, ["show", `${champion(ctx.ws)}:app.txt`]), "5");
});

test("runGauntlet: a tie fails unless RALPH_GAUNTLET_ALLOW_TIE=1", async () => {
  const ctx = setup();
  await withJev(JEV_OK, async () => {
    sandboxEnv(ctx, {});
    writeFileSync(join(ctx.ws, "app.txt"), "3");
    await runGauntlet(ctx.req, ctx.env);
    writeFileSync(join(ctx.ws, "other.txt"), "changed");
    assert.match((await runGauntlet(ctx.req, ctx.env)).reason, /regressed/);
    const out = await runGauntlet(ctx.req, { ...ctx.env, RALPH_GAUNTLET_ALLOW_TIE: "1" });
    assert.equal(out.verdict, "pass", out.reason);
  });
});

test("runGauntlet: an unchanged tree after a pass is judged alone", async () => {
  const ctx = setup();
  writeFileSync(join(ctx.ws, "app.txt"), "3");
  await withJev(JEV_OK, async () => {
    sandboxEnv(ctx, {});
    await runGauntlet(ctx.req, ctx.env);
    assert.equal((await runGauntlet(ctx.req, ctx.env)).verdict, "pass");
  });
  const calls = criticCalls(ctx.log);
  assert.doesNotMatch(calls[1].prompt, /Version B/);
});

test("runGauntlet: bar.md must be beaten", async () => {
  const ctx = setup();
  writeFileSync(join(ctx.ws, "app.txt"), "3");
  mkdirSync(join(ctx.ws, ".ralph", "gauntlet"), { recursive: true });
  writeFileSync(join(ctx.ws, ".ralph", "gauntlet", "bar.md"), "https://reference.example/app\n");
  await withJev(JEV_OK, async () => {
    sandboxEnv(ctx, {});
    const lose = await runGauntlet(ctx.req, ctx.env);
    assert.equal(lose.verdict, "fail");
    assert.match(lose.reason, /quality bar/);
    process.env.FAKE_BEATS_BAR = "1";
    const win = await runGauntlet(ctx.req, ctx.env);
    assert.equal(win.verdict, "pass", win.reason);
    assert.match(win.reason, /beat the bar/);
  });
  assert.match(criticCalls(ctx.log)[0].prompt, /https:\/\/reference\.example\/app/);
});

test("runGauntlet: criteria.md overrides the objective", async () => {
  const ctx = setup();
  writeFileSync(join(ctx.ws, "app.txt"), "3");
  mkdirSync(join(ctx.ws, ".ralph", "gauntlet"), { recursive: true });
  writeFileSync(join(ctx.ws, ".ralph", "gauntlet", "criteria.md"), "- custom one\n- custom two\n- custom three\n");
  await withJev({ c1: { noul: 1 }, c2: { noul: 1 }, c3: { noul: 1 }, verified: { noul: 1 } }, async (calls) => {
    sandboxEnv(ctx, {});
    const out = await runGauntlet(ctx.req, ctx.env);
    assert.equal(out.reason, "critic approved 3 requirement(s)");
    assert.deepEqual(Object.keys(calls[0].questions).sort(), ["c1", "c2", "c3", "verified"]);
  });
  assert.match(criticCalls(ctx.log)[0].prompt, /c3\. custom three/);
});

test("runGauntlet: the verify hint reaches the critic", async () => {
  const ctx = setup();
  writeFileSync(join(ctx.ws, "app.txt"), "3");
  await withJev(JEV_OK, async () => {
    sandboxEnv(ctx, {});
    await runGauntlet(ctx.req, { ...ctx.env, RALPH_GAUNTLET_VERIFY_HINT: "npm test" });
  });
  assert.match(criticCalls(ctx.log)[0].prompt, /\(npm test\)/);
});

for (const [mode, pattern] of [
  ["exit", /exited with 3/],
  ["nojson", /no verdict JSON/],
]) {
  test(`runGauntlet: critic ${mode} rejects and leaves no champion`, async () => {
    const ctx = setup();
    writeFileSync(join(ctx.ws, "app.txt"), "3");
    await withJev(JEV_OK, async () => {
      sandboxEnv(ctx, { FAKE_CRITIC_MODE: mode });
      await assert.rejects(runGauntlet(ctx.req, ctx.env), pattern);
    });
    assert.equal(champion(ctx.ws), null);
  });
}

test("runGauntlet: critic timeout rejects", async () => {
  const ctx = setup();
  writeFileSync(join(ctx.ws, "app.txt"), "3");
  await withJev(JEV_OK, async () => {
    sandboxEnv(ctx, { FAKE_CRITIC_MODE: "sleep" });
    await assert.rejects(runGauntlet(ctx.req, { ...ctx.env, RALPH_GAUNTLET_CRITIC_TIMEOUT_MS: "500" }), /critic/);
  });
});

test("runGauntlet: missing critic binary rejects", async () => {
  const ctx = setup();
  writeFileSync(join(ctx.ws, "app.txt"), "3");
  await withJev(JEV_OK, async () => {
    await assert.rejects(runGauntlet(ctx.req, { ...ctx.env, RALPH_GAUNTLET_CRITIC_CMD: '["/no/such/critic"]' }), /critic '\/no\/such\/critic' failed/);
  });
});

for (const mode of ["score", "exit", "vandal"]) {
  test(`runGauntlet: worktrees and scratch are cleaned up (${mode})`, async () => {
    const ctx = setup();
    writeFileSync(join(ctx.ws, "app.txt"), "3");
    await withJev(JEV_OK, async () => {
      sandboxEnv(ctx, { FAKE_CRITIC_MODE: mode });
      await runGauntlet(ctx.req, ctx.env).catch(() => {});
    });
    assert.deepEqual(readdirSync(ctx.work), []);
    assert.equal(git(ctx.ws, ["worktree", "list"]).split("\n").length, 1);
    assert.equal(readFileSync(join(ctx.ws, "app.txt"), "utf8"), "3");
  });
}

test("runGauntlet: the workspace, index and HEAD are untouched", async () => {
  const ctx = setup();
  writeFileSync(join(ctx.ws, "app.txt"), "3");
  writeFileSync(join(ctx.ws, "staged.txt"), "s");
  git(ctx.ws, ["add", "staged.txt"]);
  const before = { status: git(ctx.ws, ["status", "--porcelain"]), head: git(ctx.ws, ["rev-parse", "HEAD"]), branch: git(ctx.ws, ["branch", "--show-current"]) };
  await withJev(JEV_OK, async () => {
    sandboxEnv(ctx, {});
    await runGauntlet(ctx.req, ctx.env);
  });
  assert.deepEqual({ status: git(ctx.ws, ["status", "--porcelain"]), head: git(ctx.ws, ["rev-parse", "HEAD"]), branch: git(ctx.ws, ["branch", "--show-current"]) }, before);
});

test("runGauntlet: works in a repository without commits", async () => {
  const ctx = setup({ commit: false });
  writeFileSync(join(ctx.ws, "app.txt"), "3");
  await withJev(JEV_OK, async () => {
    sandboxEnv(ctx, {});
    assert.equal((await runGauntlet(ctx.req, ctx.env)).verdict, "pass");
  });
});

test("runGauntlet: no requirements is an error", async () => {
  const ctx = setup({ objective: "" });
  await withJev(JEV_OK, async () => {
    await assert.rejects(runGauntlet(ctx.req, ctx.env), /no requirements found/);
  });
});

test("runGauntlet: outside a git repository is an error and cleans up", async () => {
  const ctx = setup();
  const plain = scratchDir("plain");
  await withJev(JEV_OK, async () => {
    sandboxEnv(ctx, {});
    await assert.rejects(runGauntlet({ ...ctx.req, workspace: plain }, ctx.env));
  });
  assert.deepEqual(readdirSync(ctx.work), []);
});
