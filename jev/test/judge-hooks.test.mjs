import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { DIFFICULTY_LEVELS, MODES, SUGGESTED_ITERATIONS } from "../lib/hooks.mjs";
import { GAPS, GAP_ADVICE, QUESTIONS, gatherEvidence, judgeThresholds, verdictFrom } from "../lib/judge.mjs";
import { git, initRepo, int, pick, rng, scratchDir, sentence } from "./helpers.mjs";

test("judge questions cover objective, verification and gap", () => {
  assert.deepEqual(Object.keys(QUESTIONS).sort(), ["gap", "objective_met", "verified"]);
  assert.equal(QUESTIONS.gap.type, "choice");
  assert.deepEqual(QUESTIONS.gap.criteria, GAPS);
});

test("every gap except none has advice", () => {
  for (const gap of Object.keys(GAPS)) assert.equal(gap in GAP_ADVICE, gap !== "none");
});

test("judge thresholds default and read the environment", () => {
  const saved = { ...process.env };
  try {
    delete process.env.RALPH_JEV_DONE_THRESHOLD;
    delete process.env.RALPH_JEV_VERIFIED_THRESHOLD;
    assert.deepEqual(judgeThresholds(), { done: 0.6, verified: 0.5 });
    process.env.RALPH_JEV_DONE_THRESHOLD = "0.9";
    process.env.RALPH_JEV_VERIFIED_THRESHOLD = "0.1";
    assert.deepEqual(judgeThresholds(), { done: 0.9, verified: 0.1 });
  } finally {
    process.env = saved;
  }
});

for (const bad of [{}, { objective_met: { noul: 0.9 } }, { verified: { noul: 0.9 } }, null]) {
  test(`verdictFrom rejects incomplete answers ${JSON.stringify(bad)}`, () => {
    assert.throws(() => verdictFrom(bad, { done: 0.6, verified: 0.5 }), /missing noul/);
  });
}

for (let i = 0; i < 120; i++) {
  test(`verdictFrom property #${i}`, () => {
    const r = rng(70000 + i);
    const thresholds = { done: pick(r, [0.4, 0.6, 0.8]), verified: pick(r, [0.3, 0.5, 0.7]) };
    const done = Math.round(r() * 100) / 100;
    const verified = Math.round(r() * 100) / 100;
    const gap = pick(r, [...Object.keys(GAPS), undefined, "unknown_gap"]);
    const answers = { objective_met: { noul: done }, verified: { noul: verified } };
    if (gap) answers.gap = { choice: gap };
    const out = verdictFrom(answers, thresholds);
    const expectPass = done >= thresholds.done && verified >= thresholds.verified;
    assert.equal(out.verdict, expectPass ? "pass" : "fail");
    assert.ok(out.reason.includes(`objective_met=${done.toFixed(2)}`));
    assert.ok(out.reason.includes(`verified=${verified.toFixed(2)}`));
    assert.equal(out.reason.includes(`gap=${gap}`), Boolean(gap));
    if (!expectPass && GAP_ADVICE[gap]) assert.ok(out.reason.endsWith(`next: ${GAP_ADVICE[gap]}`));
    if (expectPass) assert.ok(!out.reason.includes("next:"));
    if (!expectPass) {
      const doneFirst = done < thresholds.done;
      assert.equal(out.reason.startsWith("Jev does not see the objective fully accomplished"), doneFirst);
      assert.equal(out.reason.startsWith("Jev sees no passing verification evidence"), !doneFirst);
    }
  });
}

test("gatherEvidence collects git and ralph state", async () => {
  const ws = initRepo(scratchDir("ev"));
  writeFileSync(join(ws, "a.txt"), "x");
  git(ws, ["add", "."]);
  git(ws, ["commit", "-q", "-m", "add a"]);
  writeFileSync(join(ws, "b.txt"), "y");
  mkdirSync(join(ws, ".ralph"));
  writeFileSync(join(ws, ".ralph", "events.jsonl"), '{"topic":"build.done","payload":"ok"}\n');
  const ev = await gatherEvidence({ objective: "o".repeat(5000), workspace: ws, iteration: 3, rejections: 1, closed_tasks: Array.from({ length: 40 }, (_, k) => `t${k}`) });
  assert.equal(ev.objective.length, 4000);
  assert.equal(ev.iteration, 3);
  assert.equal(ev.previous_rejections, 1);
  assert.equal(ev.closed_tasks.length, 30);
  assert.equal(ev.closed_tasks[0], "t10");
  assert.match(ev.recent_commits, /add a/);
  assert.match(ev.uncommitted_changes, /b\.txt/);
  assert.deepEqual(ev.recent_events, [{ topic: "build.done", payload: "ok" }]);
});

test("gatherEvidence outside git returns empty git fields", async () => {
  const ev = await gatherEvidence({ objective: "x", workspace: scratchDir("nogit") });
  assert.equal(ev.recent_commits, "");
  assert.equal(ev.uncommitted_changes, "");
  assert.deepEqual(ev.closed_tasks, []);
});

test("hook modes are triage and progress on the right events", () => {
  assert.deepEqual(Object.keys(MODES), ["triage", "progress"]);
  assert.equal(MODES.triage.event, "pre.loop.start");
  assert.equal(MODES.progress.event, "pre.iteration.start");
  assert.equal(MODES.triage.questions.difficulty.type, "score");
  assert.deepEqual(MODES.triage.questions.difficulty.criteria, DIFFICULTY_LEVELS);
  assert.equal(DIFFICULTY_LEVELS.length, SUGGESTED_ITERATIONS.length);
});

function withEnv(vars, fn) {
  const saved = { ...process.env };
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    process.env = saved;
  }
}

for (let i = 0; i < 120; i++) {
  test(`triage decide property #${i}`, () => {
    const r = rng(71000 + i);
    const difficulty = pick(r, [r() * 3, r() * 5 - 1, undefined, Number.NaN, "2"]);
    const ambiguous = Math.round(r() * 100) / 100;
    const maxIterations = pick(r, [undefined, 0, int(r, 1, 150)]);
    const threshold = pick(r, [undefined, "0.5", "0.9"]);
    const out = withEnv(threshold === undefined ? { RALPH_JEV_AMBIGUOUS_THRESHOLD: "" } : { RALPH_JEV_AMBIGUOUS_THRESHOLD: threshold }, () =>
      MODES.triage.decide({ difficulty: { score: difficulty }, ambiguous: { noul: ambiguous } }, { max_iterations: maxIterations }),
    );
    const level = Number.isFinite(difficulty) ? Math.min(3, Math.max(0, Math.round(difficulty))) : null;
    const suggested = level === null ? null : SUGGESTED_ITERATIONS[level];
    assert.equal(out.metadata.suggested_max_iterations, suggested);
    assert.equal(out.metadata.ambiguous, ambiguous);
    const limit = threshold === undefined ? 0.7 : Number(threshold);
    assert.equal(out.blocking, ambiguous >= limit);
    const lowWarning = out.warnings.some((w) => w.includes("looks low"));
    assert.equal(lowWarning, Boolean(suggested && maxIterations && maxIterations < suggested));
    assert.equal(out.warnings.some((w) => w.includes("definition of done")), out.blocking);
  });
}

test("triage decide requires the ambiguous answer", () => {
  assert.throws(() => MODES.triage.decide({ difficulty: { score: 1 } }, {}), /missing noul 'ambiguous'/);
});

for (let i = 0; i < 80; i++) {
  test(`progress decide property #${i}`, () => {
    const r = rng(72000 + i);
    const stalled = Math.round(r() * 100) / 100;
    const threshold = pick(r, [undefined, "0.5", "0.95"]);
    const out = withEnv({ RALPH_JEV_STALL_THRESHOLD: threshold ?? "" }, () => MODES.progress.decide({ stalled: { noul: stalled } }));
    const limit = threshold === undefined ? 0.75 : Number(threshold);
    assert.equal(out.blocking, stalled >= limit);
    assert.deepEqual(out.metadata, { stalled });
    assert.equal(out.warnings.length, out.blocking ? 1 : 0);
  });
}

for (let i = 0; i < 30; i++) {
  test(`progress skip property #${i}`, () => {
    const r = rng(73000 + i);
    const current = pick(r, [undefined, int(r, 0, 10)]);
    const min = pick(r, [undefined, String(int(r, 0, 6))]);
    const skipped = withEnv({ RALPH_JEV_PROGRESS_MIN_ITERATION: min ?? "" }, () => MODES.progress.skip({ iteration: current === undefined ? undefined : { current } }));
    assert.equal(skipped, (current ?? 0) < (min === undefined ? 3 : Number(min)));
  });
}

test("triage state reads the objective and counts tracked files", () => {
  const ws = initRepo(scratchDir("tri"));
  writeFileSync(join(ws, "a"), "1");
  writeFileSync(join(ws, "b"), "2");
  git(ws, ["add", "."]);
  git(ws, ["commit", "-q", "-m", "files"]);
  mkdirSync(join(ws, ".ralph"));
  writeFileSync(join(ws, ".ralph", "loop.lock"), JSON.stringify({ pid: 1, prompt: sentence(rng(1), 3, 5) }));
  const state = MODES.triage.state({ iteration: { max: 20 } }, ws);
  assert.equal(state.max_iterations, 20);
  assert.equal(state.repository_files, 2);
  assert.ok(state.objective.length > 0);
});

test("progress state gathers events, commits and tasks", () => {
  const ws = initRepo(scratchDir("prog"));
  mkdirSync(join(ws, ".ralph", "agent"), { recursive: true });
  writeFileSync(join(ws, ".ralph", "agent", "tasks.jsonl"), '{"status":"open"}\n');
  writeFileSync(join(ws, ".ralph", "events.jsonl"), Array.from({ length: 30 }, (_, k) => JSON.stringify({ topic: `e${k}` })).join("\n"));
  const state = MODES.progress.state({ iteration: { current: 5, max: 9 } }, ws);
  assert.equal(state.recent_events.length, 20);
  assert.equal(state.recent_events[0].topic, "e10");
  assert.deepEqual(state.tasks, { open: 1 });
  assert.deepEqual(state.iteration, { current: 5, max: 9 });
  assert.match(state.recent_commits, /init/);
});
