import assert from "node:assert/strict";
import test from "node:test";
import { criticPrompt, decide, jevStage } from "../lib/gauntlet.mjs";
import { MODES } from "../lib/hooks.mjs";
import { verdictFrom } from "../lib/judge.mjs";
import { int, pick, rng, sentence } from "./helpers.mjs";

function scenario(r) {
  const n = int(r, 1, 8);
  const criteria = Array.from({ length: n }, () => sentence(r));
  const withChampion = r() < 0.8;
  const candidate = pick(r, ["A", "B"]);
  const labels = withChampion ? { candidate, champion: candidate === "A" ? "B" : "A" } : { candidate: "A", champion: null };
  const entries = [];
  for (let k = 1; k <= n; k++) {
    for (const version of withChampion ? ["A", "B"] : ["A"]) {
      if (r() < 0.1) continue;
      entries.push({ id: `c${k}`, version, pass: r() < 0.75, evidence: sentence(r) });
    }
  }
  const critic = {
    criteria: entries,
    pick: withChampion ? pick(r, ["A", "B", "tie"]) : "A",
    beats_bar: pick(r, [true, false, null]),
    defects: Array.from({ length: int(r, 0, 3) }, () => sentence(r)),
  };
  return { critic, criteria, labels, hasBar: r() < 0.4, allowTie: r() < 0.3 };
}

const swap = (v) => (v === "A" ? "B" : v === "B" ? "A" : v);

for (let i = 0; i < 200; i++) {
  test(`decide is symmetric under relabeling A<->B #${i}`, () => {
    const r = rng(200000 + i);
    const s = scenario(r);
    if (!s.labels.champion) return;
    const mirrored = {
      ...s,
      labels: { candidate: swap(s.labels.candidate), champion: swap(s.labels.champion) },
      critic: { ...s.critic, pick: swap(s.critic.pick), criteria: s.critic.criteria.map((e) => ({ ...e, version: swap(e.version) })) },
    };
    const a = decide(s);
    const b = decide(mirrored);
    assert.equal(b.verdict, a.verdict);
    assert.equal(b.promote, a.promote);
    assert.equal(b.reason, a.reason);
  });
}

function shuffle(r, items) {
  const out = [...items];
  for (let k = out.length - 1; k > 0; k--) {
    const j = int(r, 0, k);
    [out[k], out[j]] = [out[j], out[k]];
  }
  return out;
}

for (let i = 0; i < 150; i++) {
  test(`decide ignores the order of unique critic entries #${i}`, () => {
    const r = rng(210000 + i);
    const s = scenario(r);
    const shuffled = { ...s, critic: { ...s.critic, criteria: shuffle(r, s.critic.criteria) } };
    const a = decide(s);
    const b = decide(shuffled);
    assert.equal(b.verdict, a.verdict);
    assert.equal(b.promote, a.promote);
  });
}

for (let i = 0; i < 100; i++) {
  test(`decide ignores what the critic says about the champion's requirements #${i}`, () => {
    const r = rng(220000 + i);
    const s = scenario(r);
    if (!s.labels.champion) return;
    const flipped = {
      ...s,
      critic: { ...s.critic, criteria: s.critic.criteria.map((e) => (e.version === s.labels.champion ? { ...e, pass: !e.pass, evidence: "changed" } : e)) },
    };
    assert.equal(decide(flipped).verdict, decide(s).verdict);
  });
}

for (let i = 0; i < 100; i++) {
  test(`decide verdict does not depend on defects or evidence text #${i}`, () => {
    const r = rng(230000 + i);
    const s = scenario(r);
    const changed = {
      ...s,
      critic: { ...s.critic, defects: Array.from({ length: int(r, 0, 8) }, () => sentence(r)), criteria: s.critic.criteria.map((e) => ({ ...e, evidence: sentence(r) })) },
    };
    const a = decide(s);
    const b = decide(changed);
    assert.equal(b.verdict, a.verdict);
    assert.equal(b.promote, a.promote);
  });
}

for (let i = 0; i < 100; i++) {
  test(`decide: turning a failing requirement into a pass never makes the verdict worse #${i}`, () => {
    const r = rng(240000 + i);
    const s = scenario(r);
    const before = decide(s);
    const idx = s.critic.criteria.findIndex((e) => e.version === s.labels.candidate && !e.pass);
    if (idx < 0) return;
    const improved = { ...s, critic: { ...s.critic, criteria: s.critic.criteria.map((e, k) => (k === idx ? { ...e, pass: true } : e)) } };
    const after = decide(improved);
    if (before.verdict === "pass") assert.equal(after.verdict, "pass");
    assert.equal(after.promote, before.promote);
  });
}

for (let i = 0; i < 60; i++) {
  test(`decide: allowing ties never turns a pass into a fail #${i}`, () => {
    const r = rng(250000 + i);
    const s = scenario(r);
    if (decide({ ...s, allowTie: false }).verdict === "pass") assert.equal(decide({ ...s, allowTie: true }).verdict, "pass");
  });
}

for (let i = 0; i < 60; i++) {
  test(`decide: removing the bar never turns a pass into a fail #${i}`, () => {
    const r = rng(260000 + i);
    const s = scenario(r);
    if (decide({ ...s, hasBar: true }).verdict === "pass") assert.equal(decide({ ...s, hasBar: false }).verdict, "pass");
  });
}

for (let i = 0; i < 120; i++) {
  test(`jevStage is monotonic in each probability #${i}`, () => {
    const r = rng(270000 + i);
    const n = int(r, 1, 10);
    const criteria = Array.from({ length: n }, () => sentence(r));
    const answers = { verified: { noul: r() } };
    criteria.forEach((_, k) => (answers[`c${k + 1}`] = { noul: r() }));
    const t = { criterionThreshold: pick(r, [0.3, 0.5, 0.7]), verifiedThreshold: pick(r, [0.3, 0.5, 0.7]) };
    const before = jevStage(answers, criteria, t).ok;
    const key = pick(r, [...criteria.map((_, k) => `c${k + 1}`), "verified"]);
    const raised = { ...answers, [key]: { noul: Math.min(1, answers[key].noul + r() * 0.5) } };
    if (before) assert.equal(jevStage(raised, criteria, t).ok, true);
    const stricter = { criterionThreshold: t.criterionThreshold + 0.1, verifiedThreshold: t.verifiedThreshold + 0.1 };
    if (!before) assert.equal(jevStage(answers, criteria, stricter).ok, false);
  });
}

for (let i = 0; i < 80; i++) {
  test(`verdictFrom is monotonic #${i}`, () => {
    const r = rng(280000 + i);
    const t = { done: pick(r, [0.4, 0.6]), verified: pick(r, [0.3, 0.5]) };
    const done = r();
    const verified = r();
    const base = verdictFrom({ objective_met: { noul: done }, verified: { noul: verified } }, t).verdict;
    const better = verdictFrom({ objective_met: { noul: Math.min(1, done + r() * 0.4) }, verified: { noul: Math.min(1, verified + r() * 0.4) } }, t).verdict;
    if (base === "pass") assert.equal(better, "pass");
    const looser = verdictFrom({ objective_met: { noul: done }, verified: { noul: verified } }, { done: t.done - 0.2, verified: t.verified - 0.2 }).verdict;
    if (base === "pass") assert.equal(looser, "pass");
  });
}

for (let i = 0; i < 60; i++) {
  test(`triage suggestion grows with difficulty #${i}`, () => {
    const r = rng(290000 + i);
    const lo = r() * 3;
    const hi = lo + r() * (3 - lo);
    const saved = process.env.RALPH_JEV_AMBIGUOUS_THRESHOLD;
    delete process.env.RALPH_JEV_AMBIGUOUS_THRESHOLD;
    try {
      const a = MODES.triage.decide({ difficulty: { score: lo }, ambiguous: { noul: 0.1 } }, {}).metadata.suggested_max_iterations;
      const b = MODES.triage.decide({ difficulty: { score: hi }, ambiguous: { noul: 0.1 } }, {}).metadata.suggested_max_iterations;
      assert.ok(b >= a);
    } finally {
      if (saved !== undefined) process.env.RALPH_JEV_AMBIGUOUS_THRESHOLD = saved;
    }
  });
}

for (let i = 0; i < 80; i++) {
  test(`criticPrompt is deterministic and never reveals which version is newer #${i}`, () => {
    const r = rng(300000 + i);
    const criteria = Array.from({ length: int(r, 1, 6) }, () => sentence(r));
    const dirs = { A: `/tmp/g/${int(r, 0, 9)}/A`, B: `/tmp/g/${int(r, 0, 9)}/B` };
    const a = criticPrompt({ criteria, dirs });
    assert.equal(criticPrompt({ criteria, dirs }), a);
    const swapped = criticPrompt({ criteria, dirs: { A: dirs.B, B: dirs.A } });
    assert.equal(swapped.replace(dirs.A, "X").replace(dirs.B, "Y"), a.replace(dirs.B, "X").replace(dirs.A, "Y"));
  });
}
