import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { git, initRepo, scratchDir } from "./helpers.mjs";

const bin = (name) => fileURLToPath(new URL(`../${name}`, import.meta.url));
const JUDGE = bin("ralph-jev-judge.mjs");
const HOOK = bin("ralph-jev-hook.mjs");
const GAUNTLET = bin("ralph-gauntlet-judge.mjs");

let server;
let url;
let reply = () => ({ status: 200, body: { answers: {} } });
const requests = [];

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      requests.push({ headers: req.headers, body: parsed });
      const { status, body: out } = reply(parsed);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}/v1`;
});

after(() => server.close());

function run(script, args, input, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, JEV_API_URL: url, TYPESAFE_API_KEY: "test-key", XDG_CACHE_HOME: scratchDir("cache"), ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolve({ code, stdout, stderr, lines: stdout.split("\n").filter(Boolean) }));
    child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  });
}

function answers(map) {
  reply = () => ({ status: 200, body: { answers: map } });
}

function lastJson(out) {
  return JSON.parse(out.lines[out.lines.length - 1]);
}

const judgeCases = [
  { done: 0.9, verified: 0.9, gap: "none", verdict: "pass" },
  { done: 0.6, verified: 0.5, gap: "none", verdict: "pass" },
  { done: 0.59, verified: 0.9, gap: "implementation_missing", verdict: "fail", advice: /finish the missing parts/ },
  { done: 0.9, verified: 0.49, gap: "tests_missing", verdict: "fail", advice: /run the tests/ },
  { done: 0.1, verified: 0.1, gap: "checks_failing", verdict: "fail", advice: /fix the failing checks/ },
  { done: 0.2, verified: 0.9, gap: "off_objective", verdict: "fail", advice: /re-read the objective/ },
  { done: 0.9, verified: 0.9, gap: undefined, verdict: "pass" },
  { done: 0.9, verified: 0.2, gap: "weird_new_gap", verdict: "fail" },
];

for (const c of judgeCases) {
  test(`ralph-jev-judge CLI done=${c.done} verified=${c.verified} gap=${c.gap}`, async () => {
    const map = { objective_met: { noul: c.done }, verified: { noul: c.verified } };
    if (c.gap) map.gap = { choice: c.gap };
    answers(map);
    const out = await run(JUDGE, [], { objective: "x", workspace: scratchDir("ws"), closed_tasks: [] });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(out.lines.length, 1);
    const v = lastJson(out);
    assert.deepEqual(Object.keys(v).sort(), ["reason", "verdict"]);
    assert.equal(v.verdict, c.verdict);
    if (c.advice) assert.match(v.reason, c.advice);
  });
}

test("ralph-jev-judge sends the objective and the key", async () => {
  answers({ objective_met: { noul: 1 }, verified: { noul: 1 } });
  requests.length = 0;
  await run(JUDGE, [], { objective: "Ship the header", workspace: scratchDir("ws"), iteration: 7, rejections: 2, closed_tasks: ["t1"] });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers.authorization, "Bearer test-key");
  assert.equal(requests[0].body.state.objective, "Ship the header");
  assert.equal(requests[0].body.state.iteration, 7);
  assert.equal(requests[0].body.state.previous_rejections, 2);
  assert.deepEqual(requests[0].body.state.closed_tasks, ["t1"]);
  assert.deepEqual(Object.keys(requests[0].body.questions).sort(), ["gap", "objective_met", "verified"]);
});

for (const status of [400, 401, 429, 500, 503]) {
  test(`ralph-jev-judge exits 1 on Jev HTTP ${status}`, async () => {
    reply = () => ({ status, body: {} });
    const out = await run(JUDGE, [], { objective: "x", workspace: scratchDir("ws") });
    assert.equal(out.code, 1);
    assert.equal(out.stdout, "");
    assert.match(out.stderr, new RegExp(`Jev HTTP ${status}`));
  });
}

test("ralph-jev-judge exits 2 while the circuit is open", async () => {
  const cache = scratchDir("cache");
  mkdirSync(join(cache, "ralph-jev"), { recursive: true });
  writeFileSync(join(cache, "ralph-jev", "circuit.json"), JSON.stringify({ openUntil: Date.now() + 60000 }));
  const out = await run(JUDGE, [], { objective: "x" }, { XDG_CACHE_HOME: cache });
  assert.equal(out.code, 2);
  assert.match(out.stderr, /circuit open/);
});

test("ralph-jev-judge trips the circuit on 429 and the next call exits 2", async () => {
  const cache = scratchDir("cache");
  reply = () => ({ status: 429, body: {} });
  assert.equal((await run(JUDGE, [], { objective: "x" }, { XDG_CACHE_HOME: cache })).code, 1);
  assert.equal((await run(JUDGE, [], { objective: "x" }, { XDG_CACHE_HOME: cache })).code, 2);
});

test("ralph-jev-judge exits 1 without a key", async () => {
  const out = await run(JUDGE, [], { objective: "x" }, { TYPESAFE_API_KEY: "", HOME: scratchDir("home") });
  assert.equal(out.code, 1);
  assert.match(out.stderr, /not configured/);
});

test("ralph-jev-judge exits 1 when Jev omits an answer", async () => {
  answers({ verified: { noul: 1 } });
  const out = await run(JUDGE, [], { objective: "x" });
  assert.equal(out.code, 1);
  assert.match(out.stderr, /missing noul 'objective_met'/);
});

for (const input of ["", "null", "[]", "{}"]) {
  test(`ralph-jev-judge accepts stdin ${JSON.stringify(input)}`, async () => {
    answers({ objective_met: { noul: 1 }, verified: { noul: 1 } });
    const out = await run(JUDGE, [], input);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(lastJson(out).verdict, "pass");
  });
}

test("ralph-jev-judge exits non-zero on malformed stdin", async () => {
  const out = await run(JUDGE, [], "{not json");
  assert.notEqual(out.code, 0);
  assert.equal(out.stdout, "");
});

test("ralph-jev-hook without a mode prints usage and exits 64", async () => {
  const out = await run(HOOK, [], {});
  assert.equal(out.code, 64);
  assert.match(out.stderr, /usage: ralph-jev-hook <triage\|progress>/);
});

test("ralph-jev-hook with an unknown mode exits 64", async () => {
  assert.equal((await run(HOOK, ["nope"], {})).code, 64);
});

function hookPayload(ws, current = 5, max = 30) {
  return { schema_version: 1, phase_event: "pre.iteration.start", loop: { id: "l1", workspace: ws }, iteration: { current, max } };
}

function assertMutation(out) {
  assert.equal(out.lines.length, 1);
  const parsed = JSON.parse(out.lines[0]);
  assert.deepEqual(Object.keys(parsed), ["metadata"]);
  assert.equal(typeof parsed.metadata, "object");
  assert.ok(!Array.isArray(parsed.metadata));
  return parsed.metadata;
}

for (const [stalled, code] of [
  [0.1, 0],
  [0.74, 0],
  [0.75, 1],
  [0.99, 1],
]) {
  test(`ralph-jev-hook progress stalled=${stalled} exits ${code}`, async () => {
    answers({ stalled: { noul: stalled } });
    const out = await run(HOOK, ["progress"], hookPayload(initRepo(scratchDir("ws"))));
    assert.equal(out.code, code, out.stderr);
    assert.deepEqual(assertMutation(out), { stalled });
    assert.equal(/looks stalled/.test(out.stderr), code === 1);
  });
}

for (const current of [0, 1, 2]) {
  test(`ralph-jev-hook progress skips iteration ${current} without calling Jev`, async () => {
    requests.length = 0;
    const out = await run(HOOK, ["progress"], hookPayload(scratchDir("ws"), current));
    assert.equal(out.code, 0);
    assert.deepEqual(assertMutation(out), { skipped: true });
    assert.equal(requests.length, 0);
  });
}

test("ralph-jev-hook progress honors RALPH_JEV_PROGRESS_MIN_ITERATION", async () => {
  answers({ stalled: { noul: 0.1 } });
  requests.length = 0;
  const out = await run(HOOK, ["progress"], hookPayload(initRepo(scratchDir("ws")), 1), { RALPH_JEV_PROGRESS_MIN_ITERATION: "1" });
  assert.equal(out.code, 0);
  assert.equal(requests.length, 1);
});

for (const [ambiguous, code] of [
  [0.2, 0],
  [0.69, 0],
  [0.7, 1],
  [0.95, 1],
]) {
  test(`ralph-jev-hook triage ambiguous=${ambiguous} exits ${code}`, async () => {
    answers({ difficulty: { score: 2.2 }, ambiguous: { noul: ambiguous } });
    const ws = initRepo(scratchDir("ws"));
    mkdirSync(join(ws, ".ralph"));
    writeFileSync(join(ws, ".ralph", "loop.lock"), JSON.stringify({ pid: 1, started: "now", prompt: "Build the thing" }, null, 2));
    requests.length = 0;
    const out = await run(HOOK, ["triage"], hookPayload(ws, 0, 10));
    assert.equal(out.code, code, out.stderr);
    const meta = assertMutation(out);
    assert.equal(meta.suggested_max_iterations, 40);
    assert.match(out.stderr, /max_iterations=10 looks low/);
    assert.equal(requests[0].body.state.objective, "Build the thing");
  });
}

for (const failure of [429, 500, "network"]) {
  test(`ralph-jev-hook skips with exit 0 when Jev fails (${failure})`, async () => {
    const env = failure === "network" ? { JEV_API_URL: "http://127.0.0.1:9/" } : {};
    if (failure !== "network") reply = () => ({ status: failure, body: {} });
    for (const mode of ["triage", "progress"]) {
      const out = await run(HOOK, [mode], hookPayload(initRepo(scratchDir("ws"))), env);
      assert.equal(out.code, 0, out.stderr);
      assert.equal(assertMutation(out).skipped, true);
      assert.match(out.stderr, /Jev unavailable/);
    }
  });
}

for (const mode of ["triage", "progress"]) {
  test(`ralph-jev-hook ${mode} uses the worktree loop objective`, async () => {
    answers({ difficulty: { score: 1 }, ambiguous: { noul: 0.1 }, stalled: { noul: 0.1 } });
    const root = initRepo(scratchDir("ws"));
    mkdirSync(join(root, ".ralph"));
    writeFileSync(join(root, ".ralph", "loop.lock"), JSON.stringify({ pid: 1, started: "now", prompt: "primary loop objective" }));
    const wt = join(root, ".worktrees", "brave-otter");
    mkdirSync(join(wt, ".ralph"), { recursive: true });
    const objective = `Worktree objective\n\n## Acceptance criteria\n- [ ] ${"b".repeat(150)}`;
    writeFileSync(join(wt, ".ralph", "current-objective.md"), objective);
    requests.length = 0;
    const payload = { ...hookPayload(wt, 5, 30), loop: { id: "brave-otter", workspace: wt, repo_root: root, is_primary: false } };
    const out = await run(HOOK, [mode], payload, { RALPH_JEV_PROGRESS_MIN_ITERATION: "1" });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.state.objective, objective);
  });
}

test("ralph-jev-hook skips when Jev returns an incomplete answer", async () => {
  answers({});
  const out = await run(HOOK, ["progress"], hookPayload(initRepo(scratchDir("ws"))));
  assert.equal(out.code, 0);
  assert.equal(assertMutation(out).skipped, true);
});

test("ralph-jev-hook tolerates an empty payload", async () => {
  answers({ difficulty: { score: 0 }, ambiguous: { noul: 0 } });
  const out = await run(HOOK, ["triage"], "");
  assert.equal(out.code, 0, out.stderr);
  assertMutation(out);
});

function gauntletRepo() {
  const root = scratchDir("gcli");
  const ws = join(root, "repo");
  mkdirSync(ws);
  initRepo(ws);
  writeFileSync(join(ws, "app.txt"), "ok");
  const critic = join(root, "critic.sh");
  writeFileSync(
    critic,
    `#!/bin/sh
cat > "${join(root, "prompt.txt")}"
printf '%s\n' "noise"
printf '%s\n' "$FAKE_JSON"
`,
  );
  chmodSync(critic, 0o755);
  return { root, ws, env: { RALPH_GAUNTLET_CRITIC_CMD: JSON.stringify([critic]), RALPH_GAUNTLET_WORKDIR: root } };
}

const gauntletCases = [
  { name: "critic pass", json: { criteria: [{ id: "c1", pass: true }], pick: "A", defects: [] }, code: 0, verdict: "pass" },
  { name: "critic fail", json: { criteria: [{ id: "c1", pass: false, evidence: "broken" }], pick: "A", defects: ["fix it"] }, code: 0, verdict: "fail", reason: /broken.*defects: fix it/ },
  { name: "critic without criteria entries", json: { criteria: [], pick: "A" }, code: 0, verdict: "fail", reason: /not reported/ },
];
for (const c of gauntletCases) {
  test(`ralph-gauntlet-judge CLI: ${c.name}`, async () => {
    const g = gauntletRepo();
    answers({ c1: { noul: 0.9 }, verified: { noul: 0.9 } });
    const out = await run(GAUNTLET, [], { objective: "Make app.txt ok", workspace: g.ws }, { ...g.env, FAKE_JSON: JSON.stringify(c.json) });
    assert.equal(out.code, c.code, out.stderr);
    const v = lastJson(out);
    assert.equal(v.verdict, c.verdict);
    if (c.reason) assert.match(v.reason, c.reason);
    assert.match(readFileSync(join(g.root, "prompt.txt"), "utf8"), /c1\. Make app\.txt ok/);
  });
}

test("ralph-gauntlet-judge CLI: Jev rejection means no critic run", async () => {
  const g = gauntletRepo();
  answers({ c1: { noul: 0.05 }, verified: { noul: 0.9 } });
  const out = await run(GAUNTLET, [], { objective: "Make app.txt ok", workspace: g.ws }, { ...g.env, FAKE_JSON: "{}" });
  assert.equal(out.code, 0);
  assert.match(lastJson(out).reason, /^Jev: requirements not met/);
  assert.equal(existsSync(join(g.root, "prompt.txt")), false);
});

test("ralph-gauntlet-judge CLI: unusable critic output exits 1", async () => {
  const g = gauntletRepo();
  answers({ c1: { noul: 0.9 }, verified: { noul: 0.9 } });
  const out = await run(GAUNTLET, [], { objective: "x", workspace: g.ws }, { ...g.env, FAKE_JSON: "nothing useful" });
  assert.equal(out.code, 1);
  assert.equal(out.stdout, "");
  assert.match(out.stderr, /no verdict JSON/);
});

test("ralph-gauntlet-judge CLI: output is a single JSON line", async () => {
  const g = gauntletRepo();
  answers({ c1: { noul: 0.9 }, verified: { noul: 0.9 } });
  const out = await run(GAUNTLET, [], { objective: "x", workspace: g.ws }, { ...g.env, FAKE_JSON: JSON.stringify({ criteria: [{ id: "c1", pass: true }], pick: "A" }) });
  assert.equal(out.lines.length, 1);
  assert.deepEqual(Object.keys(lastJson(out)).sort(), ["reason", "verdict"]);
  assert.equal(git(g.ws, ["worktree", "list"]).split("\n").length, 1);
});
