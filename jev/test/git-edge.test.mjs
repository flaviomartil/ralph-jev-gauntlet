import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { CHAMPION_REF, runGauntlet, snapshot } from "../lib/gauntlet-run.mjs";
import { git, initRepo, scratchDir } from "./helpers.mjs";

function tree(ws, sha) {
  return git(ws, ["ls-tree", "-r", "-z", "--name-only", sha]).split("\0").filter(Boolean).sort();
}

const nameCases = [
  "with space.txt",
  "unicodé-ç-日本.txt",
  "dash-leading-name.txt",
  "-starts-with-dash.txt",
  "quote'single.txt",
  'quote"double.txt',
  "tab\tname.txt",
  "star*name.txt",
  "question?.txt",
  "bracket[1].txt",
  "colon:name.txt",
  "deep/nested/dir/file.txt",
  ".hidden",
  ".ralphish/file.txt",
];
for (const name of nameCases) {
  test(`snapshot keeps file named ${JSON.stringify(name)}`, () => {
    const ws = initRepo(scratchDir("edge"));
    mkdirSync(join(ws, name, ".."), { recursive: true });
    writeFileSync(join(ws, name), "content");
    assert.ok(tree(ws, snapshot(ws, scratchDir("work"))).includes(name));
  });
}

test("snapshot keeps binary content byte for byte", () => {
  const ws = initRepo(scratchDir("edge"));
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  writeFileSync(join(ws, "blob.bin"), bytes);
  const sha = snapshot(ws, scratchDir("work"));
  const blob = git(ws, ["rev-parse", `${sha}:blob.bin`]);
  assert.equal(blob, git(ws, ["hash-object", join(ws, "blob.bin")]));
});

test("snapshot keeps the executable bit", () => {
  const ws = initRepo(scratchDir("edge"));
  git(ws, ["config", "core.fileMode", "true"]);
  writeFileSync(join(ws, "run.sh"), "#!/bin/sh\n");
  chmodSync(join(ws, "run.sh"), 0o755);
  git(ws, ["update-index", "--add", "--chmod=+x", "run.sh"]);
  git(ws, ["commit", "-q", "-m", "exec"]);
  const sha = snapshot(ws, scratchDir("work"));
  assert.match(git(ws, ["ls-tree", sha, "run.sh"]), /^100755 /);
});

test("snapshot keeps symlinks as links", () => {
  const ws = initRepo(scratchDir("edge"));
  writeFileSync(join(ws, "target.txt"), "t");
  try {
    symlinkSync("target.txt", join(ws, "link.txt"));
  } catch {
    return;
  }
  const sha = snapshot(ws, scratchDir("work"));
  const entry = git(ws, ["ls-tree", sha, "link.txt"]);
  if (entry) assert.match(entry, /^(120000|100644) /);
});

test("snapshot handles many files", () => {
  const ws = initRepo(scratchDir("edge"));
  for (let i = 0; i < 300; i++) {
    mkdirSync(join(ws, `d${i % 10}`), { recursive: true });
    writeFileSync(join(ws, `d${i % 10}`, `f${i}.txt`), String(i));
  }
  assert.equal(tree(ws, snapshot(ws, scratchDir("work"))).length, 300);
});

test("snapshot keeps .ralph content that is already committed but ignores local edits to it", () => {
  const ws = initRepo(scratchDir("edge"));
  mkdirSync(join(ws, ".ralph"));
  writeFileSync(join(ws, ".ralph", "committed.md"), "v1");
  git(ws, ["add", "-f", ".ralph/committed.md"]);
  git(ws, ["commit", "-q", "-m", "ralph file"]);
  writeFileSync(join(ws, ".ralph", "committed.md"), "v2");
  writeFileSync(join(ws, ".ralph", "new.md"), "n");
  const sha = snapshot(ws, scratchDir("work"));
  assert.equal(git(ws, ["show", `${sha}:.ralph/committed.md`]), "v1");
  assert.ok(!tree(ws, sha).includes(".ralph/new.md"));
});

test("snapshot works when the scratch directory path has spaces", () => {
  const ws = initRepo(scratchDir("edge"));
  writeFileSync(join(ws, "a.txt"), "a");
  const work = join(scratchDir("work"), "dir with spaces");
  mkdirSync(work);
  assert.ok(tree(ws, snapshot(ws, work)).includes("a.txt"));
});

test("snapshot works from a linked worktree", () => {
  const main = initRepo(scratchDir("edge"));
  const wt = join(scratchDir("wt"), "linked");
  git(main, ["worktree", "add", "-q", "--detach", wt]);
  writeFileSync(join(wt, "only-in-worktree.txt"), "w");
  assert.ok(tree(wt, snapshot(wt, scratchDir("work"))).includes("only-in-worktree.txt"));
});

test("snapshot on a detached HEAD", () => {
  const ws = initRepo(scratchDir("edge"));
  writeFileSync(join(ws, "a.txt"), "a");
  git(ws, ["add", "."]);
  git(ws, ["commit", "-q", "-m", "a"]);
  git(ws, ["checkout", "-q", "--detach", "HEAD"]);
  writeFileSync(join(ws, "b.txt"), "b");
  assert.deepEqual(tree(ws, snapshot(ws, scratchDir("work"))), ["a.txt", "b.txt"]);
});

function fakeCritic(root) {
  const critic = join(root, "critic.sh");
  writeFileSync(critic, `#!/bin/sh\ncat >/dev/null\nsleep 0.2\necho '{"criteria":[{"id":"c1","pass":true}],"pick":"A","defects":[]}'\n`);
  chmodSync(critic, 0o755);
  return critic;
}

async function noJev(fn) {
  const saved = { ...process.env };
  const original = globalThis.fetch;
  Object.assign(process.env, { TYPESAFE_API_KEY: "k", XDG_CACHE_HOME: scratchDir("cache") });
  globalThis.fetch = async () => {
    throw new Error("offline");
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
    process.env = saved;
  }
}

test("concurrent gauntlet runs in one repository do not collide", async () => {
  const root = scratchDir("conc");
  const ws = join(root, "repo");
  mkdirSync(ws);
  initRepo(ws);
  writeFileSync(join(ws, "a.txt"), "a");
  const work = join(root, "work");
  mkdirSync(work);
  const env = { ...process.env, RALPH_GAUNTLET_CRITIC_CMD: JSON.stringify([fakeCritic(root)]), RALPH_GAUNTLET_WORKDIR: work };
  await noJev(async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => runGauntlet({ objective: "a", workspace: ws }, env)));
    for (const r of results) assert.equal(r.verdict, "pass");
  });
  assert.deepEqual(readdirSync(work), []);
  assert.equal(git(ws, ["worktree", "list"]).split("\n").length, 1);
  assert.ok(git(ws, ["rev-parse", CHAMPION_REF]));
});

test("gauntlet run leaves no worktree metadata behind", async () => {
  const root = scratchDir("meta");
  const ws = join(root, "repo");
  mkdirSync(ws);
  initRepo(ws);
  writeFileSync(join(ws, "a.txt"), "a");
  const env = { ...process.env, RALPH_GAUNTLET_CRITIC_CMD: JSON.stringify([fakeCritic(root)]), RALPH_GAUNTLET_WORKDIR: root };
  await noJev(() => runGauntlet({ objective: "a", workspace: ws }, env));
  const meta = join(ws, ".git", "worktrees");
  let entries = [];
  try {
    entries = readdirSync(meta);
  } catch {}
  assert.deepEqual(entries, []);
});

test("gauntlet champion ref survives git gc", async () => {
  const root = scratchDir("gc");
  const ws = join(root, "repo");
  mkdirSync(ws);
  initRepo(ws);
  writeFileSync(join(ws, "a.txt"), "a");
  const env = { ...process.env, RALPH_GAUNTLET_CRITIC_CMD: JSON.stringify([fakeCritic(root)]), RALPH_GAUNTLET_WORKDIR: root };
  await noJev(() => runGauntlet({ objective: "a", workspace: ws }, env));
  const champ = git(ws, ["rev-parse", CHAMPION_REF]);
  git(ws, ["gc", "-q", "--prune=now"]);
  assert.equal(git(ws, ["cat-file", "-t", champ]), "commit");
  assert.equal(git(ws, ["show", `${champ}:a.txt`]), "a");
  assert.ok(statSync(join(ws, "a.txt")).isFile());
});
