import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { utimesSync } from "node:fs";
import { hostname } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { decide } from "../lib/gauntlet.mjs";
import { championRef, criticEnv, exportTree, isSecretLike, promoteChampion, runGauntlet, snapshot, sweepStale } from "../lib/gauntlet-run.mjs";
import { runVerify, verifyFailure } from "../lib/jev.mjs";
import { gatherEvidence, preVerdict } from "../lib/judge.mjs";
import { championSha, git, initRepo, scratchDir } from "./helpers.mjs";

const secretCases = [
  [".env", true],
  [".env.local", true],
  [".env.production", true],
  ["app/.env", true],
  [".env.example", false],
  [".ENV", true],
  [".Env.Production", true],
  ["config/.ENV.LOCAL", true],
  [".ENV.EXAMPLE", false],
  ["ID_RSA", true],
  [".NPMRC", true],
  [".env.sample", false],
  ["config/.env.template", false],
  [".env.dist", false],
  ["server.pem", true],
  ["tls/private.key", true],
  ["cert.P12", true],
  ["store.jks", true],
  ["vault.kdbx", true],
  ["terraform.tfstate", true],
  ["terraform.tfstate.backup", true],
  ["id_rsa", true],
  ["keys/id_ed25519.pub", true],
  [".npmrc", true],
  [".netrc", true],
  [".pgpass", true],
  [".git-credentials", true],
  ["credentials.json", true],
  ["secrets.yaml", true],
  ["secret", true],
  [".aws/config", true],
  ["secrets/api.json", true],
  ["config/secret/db.yml", true],
  ["credentials/token.json", true],
  ["deploy/.secrets/key.txt", true],
  ["private/notes.md", true],
  ["secrets/.env.example", true],
  ["credentials/.env.sample", true],
  [".gnupg/pubring.kbx", true],
  ["app/.env.example", false],
  ["src/secretary.ts", false],
  ["docs/credentials-guide.md", false],
  ["home/.ssh/known_hosts", true],
  ["src/env.ts", false],
  ["src/keyboard.ts", false],
  ["docs/secrets-management.md", false],
  ["README.md", false],
  ["keys.txt", false],
  ["environment.yml", false],
];
for (const [path, expected] of secretCases) {
  test(`isSecretLike(${JSON.stringify(path)}) is ${expected}`, () => assert.equal(isSecretLike(path), expected));
}

function files(ws, sha) {
  return git(ws, ["ls-tree", "-r", "-z", "--name-only", sha]).split("\0").filter(Boolean).sort();
}

test("snapshot leaves untracked secrets out and reports them", () => {
  const ws = initRepo(scratchDir("sec"));
  writeFileSync(join(ws, ".env"), "TOKEN=abc");
  writeFileSync(join(ws, ".env.example"), "TOKEN=");
  writeFileSync(join(ws, "id_rsa"), "key");
  writeFileSync(join(ws, "app.js"), "x");
  const reported = [];
  const sha = snapshot(ws, scratchDir("work"), (p) => reported.push(...p));
  assert.deepEqual(files(ws, sha), [".env.example", "app.js"]);
  assert.deepEqual(reported.sort(), [".env", "id_rsa"]);
});

test("snapshot keeps a tracked secret-like file at its committed content, never the local edit", () => {
  const ws = initRepo(scratchDir("sec"));
  writeFileSync(join(ws, "credentials.json"), "{}");
  writeFileSync(join(ws, "app.js"), "v1");
  git(ws, ["add", "."]);
  git(ws, ["commit", "-q", "-m", "tracked"]);
  writeFileSync(join(ws, "credentials.json"), '{"token":"new-secret"}');
  writeFileSync(join(ws, "app.js"), "v2");
  const sha = snapshot(ws, scratchDir("work"));
  assert.equal(git(ws, ["show", `${sha}:credentials.json`]), "{}");
  assert.equal(git(ws, ["show", `${sha}:app.js`]), "v2");
  const probe = join(scratchDir("probe"), "blob");
  writeFileSync(probe, '{"token":"new-secret"}');
  const secretBlob = git(ws, ["hash-object", probe]);
  assert.throws(() => git(ws, ["cat-file", "-e", secretBlob]), "the new secret content must never be written to the object database");
  const appBlob = git(ws, ["rev-parse", `${sha}:app.js`]);
  assert.doesNotThrow(() => git(ws, ["cat-file", "-e", appBlob]));
});

test("snapshot keeps a deleted tracked secret-like file at its committed content", () => {
  const ws = initRepo(scratchDir("sec"));
  writeFileSync(join(ws, ".env"), "A=1");
  git(ws, ["add", "-f", ".env"]);
  git(ws, ["commit", "-q", "-m", "tracked env"]);
  git(ws, ["rm", "-q", ".env"]);
  assert.equal(git(ws, ["show", `${snapshot(ws, scratchDir("work"))}:.env`]), "A=1");
});

test("snapshot works when .ralph is gitignored (regression from the real loop)", () => {
  const ws = initRepo(scratchDir("ign"));
  writeFileSync(join(ws, ".gitignore"), "node_modules/\n.ralph/\n");
  git(ws, ["add", ".gitignore"]);
  git(ws, ["commit", "-q", "-m", "ignore"]);
  mkdirSync(join(ws, ".ralph", "agent"), { recursive: true });
  writeFileSync(join(ws, ".ralph", "agent", "tasks.jsonl"), "{}");
  writeFileSync(join(ws, "slugify.js"), "export {}");
  assert.deepEqual(files(ws, snapshot(ws, scratchDir("work"))), [".gitignore", "slugify.js"]);
});

test("snapshot works when the workspace is a subdirectory of the repository", () => {
  const ws = initRepo(scratchDir("sub"));
  mkdirSync(join(ws, "pkg"));
  writeFileSync(join(ws, "pkg", "a.txt"), "a");
  writeFileSync(join(ws, "root.txt"), "r");
  assert.deepEqual(files(ws, snapshot(join(ws, "pkg"), scratchDir("work"))), ["pkg/a.txt", "root.txt"]);
});

test("snapshot commits carry no timing or authorship that differs between attempts", () => {
  const ws = initRepo(scratchDir("blind"));
  writeFileSync(join(ws, "a.txt"), "1");
  const first = snapshot(ws, scratchDir("work"));
  writeFileSync(join(ws, "a.txt"), "2");
  const second = snapshot(ws, scratchDir("work"));
  const meta = (sha) => git(ws, ["show", "-s", "--format=%an|%ae|%ad|%cn|%ce|%cd|%s", sha]);
  assert.equal(meta(first), meta(second));
});

test("exported versions have no git metadata and identical timestamps", () => {
  const ws = initRepo(scratchDir("exp"));
  writeFileSync(join(ws, "a.txt"), "1");
  const first = snapshot(ws, scratchDir("work"));
  writeFileSync(join(ws, "a.txt"), "2");
  mkdirSync(join(ws, "dir"));
  writeFileSync(join(ws, "dir", "b.txt"), "b");
  const second = snapshot(ws, scratchDir("work"));
  const out = scratchDir("out");
  exportTree(ws, first, join(out, "A"));
  exportTree(ws, second, join(out, "B"));
  assert.equal(existsSync(join(out, "A", ".git")), false);
  assert.equal(existsSync(join(out, "B", ".git")), false);
  assert.equal(readFileSync(join(out, "A", "a.txt"), "utf8"), "1");
  assert.equal(readFileSync(join(out, "B", "dir", "b.txt"), "utf8"), "b");
  assert.equal(statSync(join(out, "A", "a.txt")).mtimeMs, statSync(join(out, "B", "a.txt")).mtimeMs);
});

const singleCases = [
  [undefined, "fail"],
  [null, "fail"],
  ["A", "pass"],
  ["a", "pass"],
  ["B", "fail"],
  ["tie", "fail"],
  ["none", "fail"],
  [3, "fail"],
  [{}, "fail"],
];
for (const [pick, verdict] of singleCases) {
  test(`single version with pick ${JSON.stringify(pick)} is ${verdict}`, () => {
    const critic = { criteria: [{ id: "c1", pass: true }] };
    if (pick !== undefined) critic.pick = pick;
    const out = decide({ critic, criteria: ["x"], labels: { candidate: "A", champion: null }, hasBar: false, allowTie: true });
    assert.equal(out.verdict, verdict);
    assert.equal(out.promote, verdict === "pass");
    if (verdict === "fail") assert.match(out.reason, /invalid pick/);
  });
}

test("runVerify is null without a command", async () => {
  assert.equal(await runVerify(scratchDir("v"), {}), null);
  assert.equal(await runVerify(scratchDir("v"), { RALPH_JEV_VERIFY_CMD: "   " }), null);
});

test("runVerify reports a passing command", async () => {
  const run = await runVerify(scratchDir("v"), { RALPH_JEV_VERIFY_CMD: "echo all good" });
  assert.equal(run.passed, true);
  assert.equal(run.exit_code, 0);
  assert.match(run.output_tail, /all good/);
  assert.equal(verifyFailure(run), null);
});

test("runVerify reports a failing command with its output", async () => {
  const run = await runVerify(scratchDir("v"), { RALPH_JEV_VERIFY_CMD: "echo boom >&2; exit 3" });
  assert.equal(run.passed, false);
  assert.equal(run.exit_code, 3);
  assert.match(verifyFailure(run), /exited with 3: boom/);
});

test("runVerify runs in the workspace", async () => {
  const ws = scratchDir("v");
  writeFileSync(join(ws, "marker"), "m");
  assert.equal((await runVerify(ws, { RALPH_JEV_VERIFY_CMD: "test -f marker" })).passed, true);
});

test("runVerify times out", async () => {
  const run = await runVerify(scratchDir("v"), { RALPH_JEV_VERIFY_CMD: "sleep 5", RALPH_JEV_VERIFY_TIMEOUT_MS: "200" });
  assert.equal(run.passed, false);
  assert.equal(run.timed_out, true);
  assert.match(verifyFailure(run), /timed out/);
});

test("runVerify keeps only the tail of long output", async () => {
  const run = await runVerify(scratchDir("v"), { RALPH_JEV_VERIFY_CMD: "yes line | head -n 5000; exit 1" });
  assert.ok(run.output_tail.length <= 1500);
});

test("judge preVerdict fails fast on a failing verification and is silent otherwise", async () => {
  const ws = scratchDir("pv");
  const saved = { ...process.env };
  try {
    process.env.RALPH_JEV_VERIFY_CMD = "exit 1";
    const failing = await gatherEvidence({ objective: "x", workspace: ws });
    assert.equal(failing.verification_run.passed, false);
    assert.equal(preVerdict(failing).verdict, "fail");
    process.env.RALPH_JEV_VERIFY_CMD = "true";
    assert.equal(preVerdict(await gatherEvidence({ objective: "x", workspace: ws })), null);
    delete process.env.RALPH_JEV_VERIFY_CMD;
    const none = await gatherEvidence({ objective: "x", workspace: ws });
    assert.equal(none.verification_run, null);
    assert.equal(preVerdict(none), null);
  } finally {
    process.env = saved;
  }
});

function loopRepo() {
  const root = scratchDir("fix");
  const ws = join(root, "repo");
  mkdirSync(ws);
  initRepo(ws);
  writeFileSync(join(ws, ".gitignore"), ".ralph/\n");
  git(ws, ["add", ".gitignore"]);
  git(ws, ["commit", "-q", "-m", "ignore ralph"]);
  mkdirSync(join(ws, ".ralph"));
  writeFileSync(join(ws, ".ralph", "events.jsonl"), '{"topic":"build.done","payload":"done"}\n');
  writeFileSync(join(ws, "app.txt"), "ok");
  writeFileSync(join(ws, ".env"), "SECRET=1");
  const critic = join(root, "critic.sh");
  writeFileSync(
    critic,
    `#!/bin/sh
cat > "${join(root, "prompt.txt")}"
for d in "$PWD"/*; do ls -a "$d" >> "${join(root, "listing.txt")}"; done
echo '{"criteria":[{"id":"c1","pass":true}],"pick":"A","defects":[]}'
`,
  );
  chmodSync(critic, 0o755);
  const work = join(root, "work");
  mkdirSync(work);
  return { root, ws, work, env: { ...process.env, RALPH_GAUNTLET_CRITIC_CMD: JSON.stringify([critic]), RALPH_GAUNTLET_WORKDIR: work } };
}

async function withJev(answers, fn) {
  const saved = { ...process.env };
  const original = globalThis.fetch;
  const calls = [];
  Object.assign(process.env, { TYPESAFE_API_KEY: "k", XDG_CACHE_HOME: scratchDir("cache") });
  globalThis.fetch = async (_, init) => {
    calls.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ answers }) };
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
    process.env = saved;
  }
}

const JEV_OK = { c1: { noul: 0.9 }, verified: { noul: 0.9 } };

test("runGauntlet passes with .ralph gitignored and keeps .env away from the critic", async () => {
  const g = loopRepo();
  await withJev(JEV_OK, async () => {
    const out = await runGauntlet({ objective: "Make app ok", workspace: g.ws }, g.env);
    assert.equal(out.verdict, "pass", out.reason);
  });
  const listing = readFileSync(join(g.root, "listing.txt"), "utf8");
  assert.match(listing, /app\.txt/);
  assert.doesNotMatch(listing, /\.env/);
  assert.doesNotMatch(listing, /^\.git$/m);
  assert.doesNotMatch(listing, /\.ralph/);
  assert.equal(git(g.ws, ["show", `${championSha(g.ws)}:app.txt`]), "ok");
  assert.throws(() => git(g.ws, ["show", `${championSha(g.ws)}:.env`]));
  assert.deepEqual(readdirSync(g.work), []);
});

test("runGauntlet fails fast on a failing verification command, before Jev and the critic", async () => {
  const g = loopRepo();
  await withJev(JEV_OK, async (calls) => {
    const out = await runGauntlet({ objective: "Make app ok", workspace: g.ws }, { ...g.env, RALPH_JEV_VERIFY_CMD: "echo 2 tests failed; exit 1" });
    assert.equal(out.verdict, "fail");
    assert.match(out.reason, /verification command `echo 2 tests failed; exit 1` exited with 1: 2 tests failed/);
    assert.equal(calls.length, 0);
  });
  assert.equal(existsSync(join(g.root, "prompt.txt")), false);
});

test("runGauntlet sends a passing verification to Jev and uses it as the critic hint", async () => {
  const g = loopRepo();
  await withJev(JEV_OK, async (calls) => {
    const out = await runGauntlet({ objective: "Make app ok", workspace: g.ws }, { ...g.env, RALPH_JEV_VERIFY_CMD: "test -f app.txt" });
    assert.equal(out.verdict, "pass", out.reason);
    assert.equal(calls[0].state.verification_run.passed, true);
    assert.equal(calls[0].state.verification_run.command, "test -f app.txt");
  });
  assert.match(readFileSync(join(g.root, "prompt.txt"), "utf8"), /\(test -f app\.txt\)/);
});

test("the explicit verify hint wins over the verification command", async () => {
  const g = loopRepo();
  await withJev(JEV_OK, async () => {
    await runGauntlet({ objective: "Make app ok", workspace: g.ws }, { ...g.env, RALPH_JEV_VERIFY_CMD: "true", RALPH_GAUNTLET_VERIFY_HINT: "npm run e2e" });
  });
  assert.match(readFileSync(join(g.root, "prompt.txt"), "utf8"), /\(npm run e2e\)/);
});

test("the critic prompt paths do not reveal which version is newer", async () => {
  const g = loopRepo();
  await withJev(JEV_OK, async () => {
    await runGauntlet({ objective: "Make app ok", workspace: g.ws }, g.env);
    writeFileSync(join(g.ws, "app.txt"), "better");
    await runGauntlet({ objective: "Make app ok", workspace: g.ws }, g.env);
  });
  const prompt = readFileSync(join(g.root, "prompt.txt"), "utf8");
  const dirs = [...prompt.matchAll(/^- Version ([AB]): (.+)$/gm)].map((m) => m[2]);
  assert.equal(dirs.length, 2);
  assert.equal(dirs[0].replace(/\/A$/, ""), dirs[1].replace(/\/B$/, ""));
  assert.doesNotMatch(prompt, /champion|candidate|attempt|gauntlet\/champion/i);
});

test("championRef separates loops and requirement sets and is stable", () => {
  const a = championRef(null, ["x"]);
  assert.equal(a, championRef(undefined, ["x"]));
  assert.equal(a, championRef("primary", ["x"]));
  assert.match(a, /^refs\/gauntlet\/loop-primary-[0-9a-f]{8}\/[0-9a-f]{16}$/);
  assert.notEqual(a, championRef(null, ["y"]));
  assert.notEqual(a, championRef(null, ["x", "y"]));
  assert.notEqual(a, championRef("ralph-20260925-a1b2", ["x"]));
  assert.match(championRef("weird/../name .lock", ["x"]), /^refs\/gauntlet\/loop-weird----name--lock-[0-9a-f]{8}\//);
  assert.notEqual(championRef("a/b", ["x"]), championRef("a-b", ["x"]));
  assert.notEqual(championRef(`${"x".repeat(70)}1`, ["x"]), championRef(`${"x".repeat(70)}2`, ["x"]));
  assert.ok(championRef("x".repeat(500), ["x"]).length < 120);
});

test("championRef values are valid git refs", () => {
  const ws = initRepo(scratchDir("ref"));
  const sha = git(ws, ["rev-parse", "HEAD"]);
  for (const id of [null, "ralph-1", "a/b", "..", "-lead", "x.lock", "空"]) {
    git(ws, ["update-ref", championRef(id, ["c"]), sha]);
  }
  assert.equal(git(ws, ["for-each-ref", "refs/gauntlet/"]).split("\n").length, 7);
});

test("promoteChampion is compare-and-swap", () => {
  const ws = initRepo(scratchDir("cas"));
  writeFileSync(join(ws, "a"), "1");
  const one = snapshot(ws, scratchDir("work"));
  writeFileSync(join(ws, "a"), "2");
  const two = snapshot(ws, scratchDir("work"));
  writeFileSync(join(ws, "a"), "3");
  const three = snapshot(ws, scratchDir("work"));
  const ref = championRef(null, ["a"]);
  assert.equal(promoteChampion(ws, ref, one, ""), true);
  assert.equal(promoteChampion(ws, ref, two, ""), false);
  assert.equal(git(ws, ["rev-parse", ref]), one);
  assert.equal(promoteChampion(ws, ref, two, one), true);
  assert.equal(promoteChampion(ws, ref, three, one), false);
  assert.equal(git(ws, ["rev-parse", ref]), two);
  assert.equal(promoteChampion(ws, ref, two, one), true);
});

test("a new objective does not inherit the previous objective's champion", async () => {
  const g = loopRepo();
  await withJev({ c1: { noul: 0.9 }, c2: { noul: 0.9 }, verified: { noul: 0.9 } }, async () => {
    await runGauntlet({ objective: "Make app ok", workspace: g.ws }, g.env);
    writeFileSync(join(g.ws, "app.txt"), "changed");
    await runGauntlet({ objective: "A different task", workspace: g.ws }, g.env);
  });
  assert.doesNotMatch(readFileSync(join(g.root, "prompt.txt"), "utf8"), /Version B/);
  assert.equal(git(g.ws, ["for-each-ref", "refs/gauntlet/"]).split("\n").length, 2);
});

test("parallel loops keep separate champions", async () => {
  const g = loopRepo();
  await withJev(JEV_OK, async () => {
    await runGauntlet({ objective: "Make app ok", workspace: g.ws, loop_id: null }, g.env);
    writeFileSync(join(g.ws, "app.txt"), "changed");
    await runGauntlet({ objective: "Make app ok", workspace: g.ws, loop_id: "ralph-20260925-beef" }, g.env);
  });
  assert.doesNotMatch(readFileSync(join(g.root, "prompt.txt"), "utf8"), /Version B/);
  assert.match(git(g.ws, ["for-each-ref", "--format=%(refname)", "refs/gauntlet/"]), /loop-ralph-20260925-beef-[0-9a-f]{8}\//);
});

test("tracked secret-like files stay in the commit but never reach the critic's copy", () => {
  const ws = initRepo(scratchDir("tsec"));
  mkdirSync(join(ws, "config"));
  writeFileSync(join(ws, ".env"), "TOKEN=tracked");
  writeFileSync(join(ws, "config", "server.key"), "k");
  writeFileSync(join(ws, ".env.example"), "TOKEN=");
  writeFileSync(join(ws, "app.js"), "x");
  git(ws, ["add", "."]);
  git(ws, ["commit", "-q", "-m", "tracked secrets"]);
  const sha = snapshot(ws, scratchDir("work"));
  assert.ok(files(ws, sha).includes(".env"));
  const out = join(scratchDir("out"), "A");
  const hidden = exportTree(ws, sha, out);
  assert.deepEqual(hidden.sort(), [".env", "config/server.key"]);
  assert.equal(existsSync(join(out, ".env")), false);
  assert.equal(existsSync(join(out, "config", "server.key")), false);
  assert.equal(existsSync(join(out, ".env.example")), true);
  assert.equal(existsSync(join(out, "app.js")), true);
});

test("runGauntlet never shows a tracked .env to the critic", async () => {
  const g = loopRepo();
  writeFileSync(join(g.ws, "tracked.pem"), "pem");
  git(g.ws, ["add", "-f", ".env", "tracked.pem"]);
  git(g.ws, ["commit", "-q", "-m", "oops"]);
  await withJev(JEV_OK, async () => {
    assert.equal((await runGauntlet({ objective: "Make app ok", workspace: g.ws }, g.env)).verdict, "pass");
  });
  const listing = readFileSync(join(g.root, "listing.txt"), "utf8");
  assert.doesNotMatch(listing, /^\.env$/m);
  assert.doesNotMatch(listing, /tracked\.pem/);
  assert.match(listing, /app\.txt/);
});

function linkRepo(links) {
  const ws = initRepo(scratchDir("links"));
  mkdirSync(join(ws, "dir"));
  writeFileSync(join(ws, "dir", "real.txt"), "r");
  writeFileSync(join(ws, "top.txt"), "t");
  writeFileSync(join(ws, ".env"), "SECRET=1");
  for (const [name, target] of Object.entries(links)) symlinkSync(target, join(ws, name));
  git(ws, ["add", "-f", "."]);
  git(ws, ["commit", "-q", "-m", "links"]);
  return ws;
}

const linkCases = [
  ["inside-relative", "dir/real.txt", true],
  ["inside-dir", "dir", true],
  ["escape-parent", "../outside.txt", false],
  ["escape-absolute", "/etc/passwd", false],
  ["to-home-secret", "/home/someone/.ssh/id_rsa", false],
  ["to-tracked-env", ".env", false],
  ["self-root", ".", false],
  ["dangling-inside", "dir/missing.txt", true],
];
for (const [name, target, kept] of linkCases) {
  test(`exportTree ${kept ? "keeps" : "removes"} symlink ${name} -> ${target}`, () => {
    const ws = linkRepo({ [name]: target });
    const out = join(scratchDir("out"), "A");
    exportTree(ws, snapshot(ws, scratchDir("work")), out);
    let present = true;
    try {
      lstatSync(join(out, name));
    } catch {
      present = false;
    }
    assert.equal(present, kept);
    assert.equal(existsSync(join(out, "top.txt")), true);
  });
}

test("nested symlink escaping through a subdirectory is removed", () => {
  const ws = initRepo(scratchDir("links"));
  mkdirSync(join(ws, "a", "b"), { recursive: true });
  symlinkSync("../../../x", join(ws, "a", "b", "up"));
  symlinkSync("../sibling", join(ws, "a", "b", "ok"));
  git(ws, ["add", "."]);
  git(ws, ["commit", "-q", "-m", "nested"]);
  const out = join(scratchDir("out"), "A");
  const hidden = exportTree(ws, snapshot(ws, scratchDir("work")), out);
  assert.deepEqual(hidden, ["a/b/up"]);
});

test("versions are exported in label order, not attempt order", async () => {
  const g = loopRepo();
  const orders = new Set();
  await withJev(JEV_OK, async () => {
    for (let i = 0; i < 8; i++) {
      writeFileSync(join(g.ws, "app.txt"), `v${i}`);
      await runGauntlet({ objective: "Make app ok", workspace: g.ws }, g.env);
      const prompt = readFileSync(join(g.root, "prompt.txt"), "utf8");
      const dirs = [...prompt.matchAll(/^- Version ([AB]): (.+)$/gm)].map((m) => m[1]).join("");
      orders.add(dirs);
    }
  });
  for (const order of orders) assert.ok(order === "A" || order === "AB", order);
});

const envCases = [
  ["TYPESAFE_API_KEY", false],
  ["GITHUB_TOKEN", false],
  ["AWS_SECRET_ACCESS_KEY", false],
  ["AWS_ACCESS_KEY_ID", false],
  ["DB_PASSWORD", false],
  ["NPM_AUTH_TOKEN", false],
  ["MY_PRIVATE_KEY", false],
  ["GOOGLE_APPLICATION_CREDENTIALS", false],
  ["ANTHROPIC_API_KEY", true],
  ["CLAUDE_CODE_OAUTH_TOKEN", true],
  ["OPENAI_API_KEY", false],
  ["CODEX_HOME", true],
  ["PATH", true],
  ["GIT_AUTHOR_NAME", true],
  ["NPM_AUTH", false],
  ["AUTH_HEADER", false],
  ["HOME", true],
  ["LANG", true],
  ["FAKE_CRITIC_MODE", true],
  ["RALPH_GAUNTLET_VERIFY_HINT", true],
];
for (const [key, kept] of envCases) {
  test(`criticEnv ${kept ? "keeps" : "drops"} ${key}`, () => {
    assert.equal(key in criticEnv({ [key]: "v" }), kept);
  });
}

test("criticEnv honors RALPH_GAUNTLET_CRITIC_ENV_KEEP", () => {
  const out = criticEnv({ GITHUB_TOKEN: "t", DB_PASSWORD: "p", RALPH_GAUNTLET_CRITIC_ENV_KEEP: " GITHUB_TOKEN , X" });
  assert.equal(out.GITHUB_TOKEN, "t");
  assert.equal("DB_PASSWORD" in out, false);
});

test("runGauntlet does not pass TYPESAFE_API_KEY to the critic", async () => {
  const g = loopRepo();
  const critic = join(g.root, "env-critic.sh");
  writeFileSync(critic, `#!/bin/sh\ncat >/dev/null\nenv > "${join(g.root, "critic-env.txt")}"\necho '{"criteria":[{"id":"c1","pass":true}],"pick":"A"}'\n`);
  chmodSync(critic, 0o755);
  await withJev(JEV_OK, async () => {
    process.env.SOME_SERVICE_TOKEN = "leak";
    await runGauntlet({ objective: "Make app ok", workspace: g.ws }, { ...g.env, RALPH_GAUNTLET_CRITIC_CMD: JSON.stringify([critic]) });
  });
  const seen = readFileSync(join(g.root, "critic-env.txt"), "utf8");
  assert.doesNotMatch(seen, /TYPESAFE_API_KEY/);
  assert.doesNotMatch(seen, /SOME_SERVICE_TOKEN/);
  assert.match(seen, /^PATH=/m);
});

const providerCases = [
  [{}, "ANTHROPIC_API_KEY", true],
  [{}, "OPENAI_API_KEY", false],
  [{ RALPH_GAUNTLET_CRITIC: "claude" }, "CLAUDE_CODE_OAUTH_TOKEN", true],
  [{ RALPH_GAUNTLET_CRITIC: "codex" }, "OPENAI_API_KEY", true],
  [{ RALPH_GAUNTLET_CRITIC: "codex" }, "CODEX_API_KEY", true],
  [{ RALPH_GAUNTLET_CRITIC: "codex" }, "ANTHROPIC_API_KEY", false],
  [{ RALPH_GAUNTLET_CRITIC: "codex" }, "CLAUDE_CODE_OAUTH_TOKEN", false],
  [{ RALPH_GAUNTLET_CRITIC_CMD: '["x"]' }, "ANTHROPIC_API_KEY", false],
  [{ RALPH_GAUNTLET_CRITIC_CMD: '["x"]' }, "OPENAI_API_KEY", false],
  [{ RALPH_GAUNTLET_CRITIC_CMD: '["x"]', RALPH_GAUNTLET_CRITIC_ENV_KEEP: "OPENAI_API_KEY" }, "OPENAI_API_KEY", true],
];
for (const [base, key, kept] of providerCases) {
  test(`criticEnv with ${JSON.stringify(base)} ${kept ? "keeps" : "drops"} ${key}`, () => {
    assert.equal(key in criticEnv({ ...base, [key]: "v" }), kept);
  });
}

test("sweepStale removes orphaned or old unowned scratch directories only", () => {
  const base = scratchDir("sweep");
  const make = (name, owner, ageMs = 0) => {
    const dir = join(base, name);
    mkdirSync(dir);
    if (owner) writeFileSync(join(dir, ".owner.json"), JSON.stringify(owner));
    if (ageMs) {
      const t = new Date(Date.now() - ageMs);
      utimesSync(dir, t, t);
    }
  };
  const host = hostname();
  const threeHours = 3 * 60 * 60 * 1000;
  make("ralph-gauntlet-live-old", { pid: process.pid, host }, threeHours);
  make("ralph-gauntlet-dead", { pid: 2147483646, host });
  make("ralph-gauntlet-other-host", { pid: 2147483646, host: `${host}-elsewhere` });
  make("ralph-gauntlet-unowned-old", null, threeHours);
  make("ralph-gauntlet-unowned-new", null);
  make("unrelated-old", null, threeHours);
  writeFileSync(join(base, "ralph-gauntlet-file"), "x");
  assert.equal(sweepStale(base), 2);
  assert.deepEqual(readdirSync(base).sort(), ["ralph-gauntlet-file", "ralph-gauntlet-live-old", "ralph-gauntlet-other-host", "ralph-gauntlet-unowned-new", "unrelated-old"]);
  assert.equal(sweepStale(join(base, "missing")), 0);
});

test("a running gauntlet claims its scratch directory", async () => {
  const g = loopRepo();
  const critic = join(g.root, "peek-critic.sh");
  writeFileSync(critic, `#!/bin/sh\ncat >/dev/null\ncat "$PWD/../.owner.json" > "${join(g.root, "owner-seen.json")}"\necho '{"criteria":[{"id":"c1","pass":true}],"pick":"A"}'\n`);
  chmodSync(critic, 0o755);
  await withJev(JEV_OK, async () => {
    await runGauntlet({ objective: "Make app ok", workspace: g.ws }, { ...g.env, RALPH_GAUNTLET_CRITIC_CMD: JSON.stringify([critic]) });
  });
  const owner = JSON.parse(readFileSync(join(g.root, "owner-seen.json"), "utf8"));
  assert.equal(owner.pid, process.pid);
  assert.equal(owner.host, hostname());
});

test("the gauntlet judge removes its scratch copies when terminated mid-critique", async () => {
  const g = loopRepo();
  const critic = join(g.root, "slow-critic.sh");
  writeFileSync(critic, `#!/bin/sh\ncat >/dev/null\ntouch "${join(g.root, "critic-started")}"\nsleep 30\n`);
  chmodSync(critic, 0o755);
  const judge = fileURLToPath(new URL("../ralph-gauntlet-judge.mjs", import.meta.url));
  const child = spawn(process.execPath, [judge], {
    env: { ...g.env, RALPH_GAUNTLET_CRITIC_CMD: JSON.stringify([critic]), JEV_API_URL: "http://127.0.0.1:9/", TYPESAFE_API_KEY: "k", XDG_CACHE_HOME: scratchDir("cache") },
    detached: true,
  });
  child.stdin.end(JSON.stringify({ objective: "Make app ok", workspace: g.ws }));
  const started = Date.now();
  while (!existsSync(join(g.root, "critic-started"))) {
    if (Date.now() - started > 20000) throw new Error("critic never started");
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(readdirSync(g.work).length, 1);
  const exited = new Promise((resolve) => child.on("close", resolve));
  process.kill(-child.pid, "SIGTERM");
  await exited;
  assert.deepEqual(readdirSync(g.work), []);
});

test("secret filtering sees the full path even when a directory name contains a tab", () => {
  const ws = initRepo(scratchDir("tab"));
  mkdirSync(join(ws, "safe\tdir"));
  writeFileSync(join(ws, "safe\tdir", ".env"), "SECRET=1");
  writeFileSync(join(ws, "safe\tdir", "ok.txt"), "ok");
  git(ws, ["add", "-f", "."]);
  git(ws, ["commit", "-q", "-m", "tab"]);
  const out = join(scratchDir("out"), "A");
  const hidden = exportTree(ws, snapshot(ws, scratchDir("work")), out);
  assert.deepEqual(hidden, ["safe\tdir/.env"]);
  assert.equal(existsSync(join(out, "safe\tdir", ".env")), false);
  assert.equal(existsSync(join(out, "safe\tdir", "ok.txt")), true);
});

test("the gauntlet judge cleans up even when the critic ignores SIGTERM", async () => {
  const g = loopRepo();
  const critic = join(g.root, "stubborn-critic.sh");
  writeFileSync(critic, `#!/bin/sh\ntrap '' TERM\ncat >/dev/null\ntouch "${join(g.root, "critic-started")}"\nsleep 30\n`);
  chmodSync(critic, 0o755);
  const judge = fileURLToPath(new URL("../ralph-gauntlet-judge.mjs", import.meta.url));
  const child = spawn(process.execPath, [judge], {
    env: { ...g.env, RALPH_GAUNTLET_CRITIC_CMD: JSON.stringify([critic]), JEV_API_URL: "http://127.0.0.1:9/", TYPESAFE_API_KEY: "k", XDG_CACHE_HOME: scratchDir("cache") },
    detached: true,
  });
  child.stdin.end(JSON.stringify({ objective: "Make app ok", workspace: g.ws }));
  const started = Date.now();
  while (!existsSync(join(g.root, "critic-started"))) {
    if (Date.now() - started > 20000) throw new Error("critic never started");
    await new Promise((r) => setTimeout(r, 50));
  }
  const exited = new Promise((resolve) => child.on("close", resolve));
  const t0 = Date.now();
  process.kill(-child.pid, "SIGTERM");
  await exited;
  assert.ok(Date.now() - t0 < 2500, `judge took ${Date.now() - t0}ms to exit`);
  assert.deepEqual(readdirSync(g.work), []);
});

test("runCritic enforces its timeout asynchronously", async () => {
  const g = loopRepo();
  const critic = join(g.root, "sleepy.sh");
  writeFileSync(critic, "#!/bin/sh\ncat >/dev/null\nsleep 30\n");
  chmodSync(critic, 0o755);
  const { runCritic } = await import("../lib/gauntlet-run.mjs");
  const t0 = Date.now();
  await assert.rejects(runCritic("p", g.root, { ...g.env, RALPH_GAUNTLET_CRITIC_CMD: JSON.stringify([critic]), RALPH_GAUNTLET_CRITIC_TIMEOUT_MS: "300" }), /timed out after 300ms/);
  assert.ok(Date.now() - t0 < 5000);
});

test("runVerify kills background children when it times out", async () => {
  const ws = scratchDir("vk");
  const marker = join(ws, "late-write");
  const run = await runVerify(ws, { RALPH_JEV_VERIFY_CMD: `(sleep 1; touch ${marker}) & sleep 5`, RALPH_JEV_VERIFY_TIMEOUT_MS: "200" });
  assert.equal(run.timed_out, true);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(existsSync(marker), false);
});

test("runVerify kills background children left behind by a finished command", async () => {
  const ws = scratchDir("vk");
  const marker = join(ws, "late-write");
  const run = await runVerify(ws, { RALPH_JEV_VERIFY_CMD: `(sleep 1; touch ${marker}) & echo done` });
  assert.equal(run.passed, true);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(existsSync(marker), false);
});

test("background children of a finished critic are killed", async () => {
  const g = loopRepo();
  const marker = join(g.root, "critic-orphan");
  const critic = join(g.root, "orphan-critic.sh");
  writeFileSync(critic, `#!/bin/sh\ncat >/dev/null\n(sleep 1; touch "${marker}") >/dev/null 2>&1 &\necho '{"criteria":[{"id":"c1","pass":true}],"pick":"A"}'\n`);
  chmodSync(critic, 0o755);
  const { runCritic } = await import("../lib/gauntlet-run.mjs");
  const out = await runCritic("p", g.root, { ...g.env, RALPH_GAUNTLET_CRITIC_CMD: JSON.stringify([critic]) });
  assert.match(out, /"pick":"A"/);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(existsSync(marker), false);
});

test("critic stderr does not leak into the parsed verdict", async () => {
  const g = loopRepo();
  const critic = join(g.root, "noisy-critic.sh");
  writeFileSync(critic, `#!/bin/sh\ncat >/dev/null\necho '{"criteria":[{"id":"c1","pass":true}],"pick":"A"}'\necho '{"criteria":[],"pick":"B"}' >&2\n`);
  chmodSync(critic, 0o755);
  const { runCritic } = await import("../lib/gauntlet-run.mjs");
  const out = await runCritic("p", g.root, { ...g.env, RALPH_GAUNTLET_CRITIC_CMD: JSON.stringify([critic]) });
  assert.doesNotMatch(out, /"pick":"B"/);
});

test("tracked loop state under .ralph never reaches the critic's copy", () => {
  const ws = initRepo(scratchDir("rstate"));
  mkdirSync(join(ws, ".ralph", "agent"), { recursive: true });
  writeFileSync(join(ws, ".ralph", "agent", "scratchpad.md"), "attempt 3 of 5, previous one was better");
  writeFileSync(join(ws, ".ralphrc"), "kept");
  writeFileSync(join(ws, "app.js"), "x");
  git(ws, ["add", "-f", "."]);
  git(ws, ["commit", "-q", "-m", "tracked ralph"]);
  const out = join(scratchDir("out"), "A");
  const hidden = exportTree(ws, snapshot(ws, scratchDir("work")), out);
  assert.deepEqual(hidden, [".ralph/agent/scratchpad.md"]);
  assert.equal(existsSync(join(out, ".ralph")), false);
  assert.equal(existsSync(join(out, ".ralphrc")), true);
  assert.equal(existsSync(join(out, "app.js")), true);
});

test("snapshot includes ignored files that the user force-staged", () => {
  const ws = initRepo(scratchDir("force"));
  writeFileSync(join(ws, ".gitignore"), "generated/\n");
  git(ws, ["add", ".gitignore"]);
  git(ws, ["commit", "-q", "-m", "ignore"]);
  mkdirSync(join(ws, "generated"));
  writeFileSync(join(ws, "generated", "schema.json"), "{}");
  writeFileSync(join(ws, "generated", "other.json"), "{}");
  writeFileSync(join(ws, "generated", ".env"), "S=1");
  git(ws, ["add", "-f", "generated/schema.json", "generated/.env"]);
  const files_ = files(ws, snapshot(ws, scratchDir("work")));
  assert.ok(files_.includes("generated/schema.json"));
  assert.ok(!files_.includes("generated/other.json"));
  assert.ok(!files_.includes("generated/.env"));
});

test("snapshot includes force-staged ignored files in a repository without commits", () => {
  const ws = initRepo(scratchDir("force"), { commit: false });
  writeFileSync(join(ws, ".gitignore"), "*.gen\n");
  writeFileSync(join(ws, "a.gen"), "x");
  git(ws, ["add", "-f", "a.gen", ".gitignore"]);
  assert.deepEqual(files(ws, snapshot(ws, scratchDir("work"))), [".gitignore", "a.gen"]);
});
