import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assignLabels, criticPrompt, decide, jevStage, parseCriteria, parseCriticOutput } from "../lib/gauntlet.mjs";

const JUDGE = fileURLToPath(new URL("../ralph-gauntlet-judge.mjs", import.meta.url));
const SCRATCH = process.env.RALPH_GAUNTLET_TEST_DIR || process.env.TMPDIR || "/tmp";

test("parseCriteria prefers criteria file bullets", () => {
  assert.deepEqual(parseCriteria({ criteriaFile: "# Done\n- header renders\n- [ ] test covers it\n", objective: "x" }), [
    "header renders",
    "test covers it",
  ]);
});

test("parseCriteria reads an acceptance criteria section from the objective", () => {
  const objective = "Add a header.\n\n## Acceptance criteria\n1. Header before <p>\n2. Test passes\n\n## Notes\n- ignore me";
  assert.deepEqual(parseCriteria({ objective }), ["Header before <p>", "Test passes"]);
});

test("parseCriteria falls back to the whole objective", () => {
  assert.deepEqual(parseCriteria({ objective: "Make it faster" }), ["Make it faster"]);
});

test("jevStage fails on a weak requirement and on missing verification", () => {
  const criteria = ["a", "b"];
  const result = jevStage({ c1: { noul: 0.9 }, c2: { noul: 0.2 }, verified: { noul: 0.1 } }, criteria, {
    criterionThreshold: 0.5,
    verifiedThreshold: 0.5,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /c2 "b"/);
  assert.match(result.reason, /verified=0.10/);
  assert.equal(jevStage({ c1: { noul: 0.9 }, c2: { noul: 0.8 }, verified: { noul: 0.9 } }, criteria, { criterionThreshold: 0.5, verifiedThreshold: 0.5 }).ok, true);
});

test("assignLabels randomizes the blind pair", () => {
  assert.deepEqual(assignLabels(false), { candidate: "A", champion: null });
  assert.deepEqual(assignLabels(true, () => 0.1), { candidate: "A", champion: "B" });
  assert.deepEqual(assignLabels(true, () => 0.9), { candidate: "B", champion: "A" });
});

test("criticPrompt hides which version is new", () => {
  const prompt = criticPrompt({ criteria: ["x"], dirs: { A: "/w/A", B: "/w/B" }, bar: "" });
  assert.match(prompt, /labels assigned at random/);
  assert.doesNotMatch(prompt, /candidate|champion|previous/i);
});

test("parseCriticOutput takes the last JSON line", () => {
  const out = 'thinking...\n{"note":1}\n{"criteria":[{"id":"c1","pass":true}],"pick":"A","defects":[]}\n';
  assert.equal(parseCriticOutput(out).pick, "A");
  assert.throws(() => parseCriticOutput("no json here"));
});

test("decide requires every requirement and a win over the champion", () => {
  const criteria = ["a", "b"];
  const labels = { candidate: "B", champion: "A" };
  const pass = decide({
    critic: { criteria: [{ id: "c1", version: "B", pass: true }, { id: "c2", version: "B", pass: true }, { id: "c1", version: "A", pass: false }], pick: "B", defects: [] },
    criteria,
    labels,
    hasBar: false,
    allowTie: false,
  });
  assert.equal(pass.verdict, "pass");
  assert.equal(pass.promote, true);

  const regressed = decide({
    critic: { criteria: [{ id: "c1", version: "B", pass: true }, { id: "c2", version: "B", pass: true }], pick: "A", defects: ["slower"] },
    criteria,
    labels,
    hasBar: false,
    allowTie: false,
  });
  assert.equal(regressed.verdict, "fail");
  assert.equal(regressed.promote, false);
  assert.match(regressed.reason, /regressed/);

  const missing = decide({ critic: { criteria: [{ id: "c1", pass: true }], pick: "A", defects: [] }, criteria, labels: { candidate: "A", champion: null }, hasBar: true, allowTie: false });
  assert.equal(missing.verdict, "fail");
  assert.match(missing.reason, /c2 "b"/);
  assert.match(missing.reason, /quality bar/);
});

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("end to end: rejects, keeps the best attempt as champion, then passes on a blind win", () => {
  const root = mkdtempSync(join(SCRATCH, "gauntlet-e2e-"));
  const ws = join(root, "repo");
  mkdirSync(ws);
  run("git", ["init", "-q"], ws);
  run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], ws);
  writeFileSync(join(ws, "app.txt"), "v1\n");

  const critic = join(root, "critic.sh");
  writeFileSync(
    critic,
    `#!/bin/sh
prompt=$(cat)
new=A
for v in A B; do
  dir=$(printf '%s\\n' "$prompt" | sed -n "s/^- Version $v: //p")
  [ -n "$dir" ] && grep -q v2 "$dir/app.txt" && new=$v
done
if grep -rq v2 "$PWD"/*/app.txt 2>/dev/null; then pass=true; else pass=false; fi
echo "critic ran"
echo "{\\"criteria\\":[{\\"id\\":\\"c1\\",\\"pass\\":$pass}],\\"pick\\":\\"$new\\",\\"beats_bar\\":null,\\"defects\\":[\\"app.txt still v1\\"]}"
`,
  );
  chmodSync(critic, 0o755);

  const env = {
    ...process.env,
    RALPH_GAUNTLET_CRITIC_CMD: JSON.stringify([critic]),
    JEV_API_URL: "http://127.0.0.1:9/",
    TYPESAFE_API_KEY: "test",
    XDG_CACHE_HOME: root,
    RALPH_GAUNTLET_WORKDIR: root,
  };
  const judge = () =>
    JSON.parse(
      spawnSync("node", [JUDGE], {
        input: JSON.stringify({ objective: "Bump app.txt to v2", workspace: ws, closed_tasks: [] }),
        encoding: "utf8",
        env,
      }).stdout.trim(),
    );

  const first = judge();
  assert.equal(first.verdict, "fail");
  assert.match(first.reason, /c1/);
  const champion1 = run("git", ["rev-parse", "refs/gauntlet/champion"], ws);

  writeFileSync(join(ws, "app.txt"), "v2\n");
  const second = judge();
  assert.equal(second.verdict, "pass", second.reason);
  assert.notEqual(run("git", ["rev-parse", "refs/gauntlet/champion"], ws), champion1);
  assert.equal(run("git", ["worktree", "list"], ws).split("\n").length, 1);
  assert.equal(run("git", ["status", "--short"], ws), "?? app.txt");
});
