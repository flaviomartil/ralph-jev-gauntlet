import assert from "node:assert/strict";
import test from "node:test";
import { assignLabels, balancedObjectAt, criticPrompt, decide, jevQuestions, jevStage, parseCriticOutput } from "../lib/gauntlet.mjs";
import { int, pick, rng, sentence } from "./helpers.mjs";

const T = { criterionThreshold: 0.5, verifiedThreshold: 0.5 };

test("jevQuestions has one noul per requirement plus verified", () => {
  const q = jevQuestions(["a", "b", "c"]);
  assert.deepEqual(Object.keys(q).sort(), ["c1", "c2", "c3", "verified"]);
  for (const v of Object.values(q)) assert.equal(v.type, "noul");
  assert.match(q.c2.instructions, /criteria\[1\]/);
});

test("jevQuestions with no requirements only asks verified", () => {
  assert.deepEqual(Object.keys(jevQuestions([])), ["verified"]);
});

const stageCases = [
  { name: "all above", answers: { c1: { noul: 0.9 }, verified: { noul: 0.9 } }, ok: true },
  { name: "exactly at threshold passes", answers: { c1: { noul: 0.5 }, verified: { noul: 0.5 } }, ok: true },
  { name: "just below fails", answers: { c1: { noul: 0.4999 }, verified: { noul: 0.9 } }, ok: false },
  { name: "missing answers are not failures", answers: {}, ok: true },
  { name: "null answers", answers: null, ok: true },
  { name: "non numeric noul ignored", answers: { c1: { noul: "0.1" }, verified: { noul: "no" } }, ok: true },
  { name: "unverified only", answers: { c1: { noul: 0.9 }, verified: { noul: 0.1 } }, ok: false },
  { name: "zero probability", answers: { c1: { noul: 0 }, verified: { noul: 1 } }, ok: false },
];

for (const c of stageCases) {
  test(`jevStage: ${c.name}`, () => {
    assert.equal(jevStage(c.answers, ["only"], T).ok, c.ok);
  });
}

for (let i = 0; i < 160; i++) {
  test(`jevStage property #${i}`, () => {
    const r = rng(20000 + i);
    const n = int(r, 1, 12);
    const criteria = Array.from({ length: n }, () => sentence(r));
    const criterionThreshold = pick(r, [0.3, 0.5, 0.7]);
    const verifiedThreshold = pick(r, [0.3, 0.5, 0.7]);
    const answers = {};
    const failing = [];
    criteria.forEach((_, k) => {
      if (r() < 0.1) return;
      const p = Math.round(r() * 1000) / 1000;
      answers[`c${k + 1}`] = { noul: p };
      if (p < criterionThreshold) failing.push(`c${k + 1}`);
    });
    const hasVerified = r() < 0.9;
    const verified = Math.round(r() * 1000) / 1000;
    if (hasVerified) answers.verified = { noul: verified };
    const unverified = hasVerified && verified < verifiedThreshold;
    const result = jevStage(answers, criteria, { criterionThreshold, verifiedThreshold });
    assert.equal(result.ok, failing.length === 0 && !unverified);
    if (!result.ok) {
      for (const id of failing) assert.ok(result.reason.includes(`${id} "`), `${id} missing from ${result.reason}`);
      const listed = [...result.reason.matchAll(/(c\d+) "/g)].map((m) => m[1]);
      assert.deepEqual(listed, failing);
      assert.equal(result.reason.includes("no passing verification evidence"), unverified);
      assert.ok(result.reason.startsWith("Jev: requirements not met: "));
    }
  });
}

for (let i = 0; i < 60; i++) {
  test(`assignLabels property #${i}`, () => {
    const value = i / 60;
    const labels = assignLabels(true, () => value);
    assert.deepEqual(labels, value < 0.5 ? { candidate: "A", champion: "B" } : { candidate: "B", champion: "A" });
    assert.notEqual(labels.candidate, labels.champion);
    assert.deepEqual(assignLabels(false, () => value), { candidate: "A", champion: null });
  });
}

test("assignLabels is roughly balanced with Math.random", () => {
  let a = 0;
  for (let k = 0; k < 2000; k++) if (assignLabels(true).candidate === "A") a++;
  assert.ok(a > 850 && a < 1150, `A chosen ${a}/2000`);
});

for (let i = 0; i < 100; i++) {
  test(`criticPrompt property #${i}`, () => {
    const r = rng(30000 + i);
    const criteria = Array.from({ length: int(r, 1, 12) }, () => sentence(r));
    const two = r() < 0.6;
    const dirs = two ? { A: `/w/${int(r, 0, 99)}/A`, B: `/w/${int(r, 0, 99)}/B` } : { A: `/w/${int(r, 0, 99)}/A` };
    const bar = r() < 0.4 ? `https://example.com/${sentence(r, 1, 2).replace(/ /g, "-")}` : "";
    const verifyHint = r() < 0.4 ? pick(r, ["npm test", "cargo test", "pytest -q"]) : undefined;
    const prompt = criticPrompt({ criteria, dirs, bar, verifyHint });
    criteria.forEach((c, k) => assert.ok(prompt.includes(`c${k + 1}. ${c}`)));
    for (const [v, d] of Object.entries(dirs)) assert.ok(prompt.includes(`- Version ${v}: ${d}`));
    assert.equal(prompt.includes("labels assigned at random"), two);
    assert.equal(prompt.includes("Quality bar"), Boolean(bar));
    if (bar) assert.ok(prompt.includes(bar));
    if (verifyHint) assert.ok(prompt.includes(`(${verifyHint})`));
    assert.doesNotMatch(prompt, /champion|candidate|previous attempt|newer version is/i);
    assert.match(prompt, /exactly one line of JSON/);
    assert.equal(prompt.includes('"A", "B" or "tie"'), two);
    assert.equal(prompt.includes('"beats_bar" is true or false'), Boolean(bar));
  });
}

function verdictObject(r) {
  const n = int(r, 0, 6);
  return {
    criteria: Array.from({ length: n }, (_, k) => ({ id: `c${k + 1}`, version: pick(r, ["A", "B"]), pass: r() < 0.5, evidence: sentence(r) })),
    pick: pick(r, ["A", "B", "tie"]),
    beats_bar: pick(r, [null, true, false]),
    defects: Array.from({ length: int(r, 0, 4) }, () => `${sentence(r)} {braces} "quotes" \\ backslash`),
  };
}

function noise(r) {
  return pick(r, [
    "Running tests...",
    "ok 1 - suite",
    "{ not json",
    '{"note": "no criteria here"}',
    "function x() { return { a: 1 }; }",
    "```",
    "```json",
    "Summary: all {good}",
    "}",
    "",
  ]);
}

for (let i = 0; i < 140; i++) {
  test(`parseCriticOutput property #${i}`, () => {
    const r = rng(40000 + i);
    const decoy = { ...verdictObject(r), pick: "DECOY" };
    const verdict = verdictObject(r);
    const lines = [];
    for (let k = 0; k < int(r, 0, 6); k++) lines.push(noise(r));
    if (r() < 0.3) lines.push(JSON.stringify(decoy));
    for (let k = 0; k < int(r, 0, 4); k++) lines.push(noise(r));
    const style = int(r, 0, 3);
    const body = style === 1 ? JSON.stringify(verdict, null, 2) : JSON.stringify(verdict);
    if (style === 2) lines.push("```json", body, "```");
    else if (style === 3) lines.push(`Final verdict: ${body} (end)`);
    else lines.push(body);
    for (let k = 0; k < int(r, 0, 3); k++) lines.push(pick(r, ["done.", "Thanks", "", "```"]));
    assert.deepEqual(parseCriticOutput(lines.join("\n")), verdict);
  });
}

const parseFailures = ["", "no json", "{}", '{"criteria": "not array"}', "{ broken", '{"criteria": [1,2', null, undefined];
for (const input of parseFailures) {
  test(`parseCriticOutput rejects ${JSON.stringify(input)}`, () => {
    assert.throws(() => parseCriticOutput(input), /no verdict JSON/);
  });
}

test("parseCriticOutput accepts an empty criteria list", () => {
  assert.deepEqual(parseCriticOutput('{"criteria":[],"pick":"A"}').criteria, []);
});

test("parseCriticOutput returns the last verdict when two are present", () => {
  const out = '{"criteria":[],"pick":"A"}\ntext\n{"criteria":[],"pick":"B"}';
  assert.equal(parseCriticOutput(out).pick, "B");
});

test("parseCriticOutput handles braces inside strings", () => {
  const out = 'x {\n{"criteria":[{"id":"c1","evidence":"saw } and { and \\" quote"}],"pick":"A"}';
  assert.equal(parseCriticOutput(out).criteria[0].evidence, 'saw } and { and " quote');
});

test("parseCriticOutput survives many stray braces", () => {
  const out = `${"{ ".repeat(20000)}\n{"criteria":[],"pick":"A"}`;
  assert.equal(parseCriticOutput(out).pick, "A");
});

const balancedCases = [
  ["{}", 0, "{}"],
  ['{"a":{"b":1}} tail', 0, '{"a":{"b":1}}'],
  ['{"a":"}"}', 0, '{"a":"}"}'],
  ['{"a":"\\"}"}', 0, '{"a":"\\"}"}'],
  ["{ open", 0, null],
  ["x{}", 1, "{}"],
];
for (const [text, start, expected] of balancedCases) {
  test(`balancedObjectAt(${JSON.stringify(text)}, ${start})`, () => {
    assert.equal(balancedObjectAt(text, start), expected);
  });
}

function oracle({ critic, criteria, labels, hasBar, allowTie }) {
  const norm = (v) => (typeof v === "string" ? v.trim().toUpperCase() : null);
  const entries = (Array.isArray(critic.criteria) ? critic.criteria : []).filter((c) => c && typeof c === "object");
  const failedIds = [];
  criteria.forEach((_, i) => {
    const id = `c${i + 1}`;
    const entry = entries.find(
      (c) => (c.version == null || norm(c.version) === labels.candidate) && String(c.id ?? "").trim().toLowerCase() === id,
    );
    if (!entry || entry.pass !== true) failedIds.push(id);
  });
  const p = norm(critic.pick);
  const won = !labels.champion || p === labels.candidate || (allowTie && p === "TIE");
  const bar = !hasBar || critic.beats_bar === true;
  return { failedIds, won, bar, pass: failedIds.length === 0 && won && bar, promote: !labels.champion || p === labels.candidate };
}

function randomCritic(r, n) {
  const entries = [];
  for (let k = 0; k < n + int(r, -1, 3); k++) {
    const kind = r();
    if (kind < 0.05) entries.push(null);
    else if (kind < 0.08) entries.push("junk");
    else
      entries.push({
        id: pick(r, [`c${int(r, 1, n + 1)}`, ` C${int(r, 1, n)} `, `c${int(r, 1, n)}`]),
        version: pick(r, ["A", "B", "a", " b ", undefined, null]),
        pass: pick(r, [true, true, true, false, "true", 1]),
        evidence: pick(r, [sentence(r), undefined, 42]),
      });
  }
  return {
    criteria: entries,
    pick: pick(r, ["A", "B", "a", " b", "tie", "TIE", "none", undefined, 3]),
    beats_bar: pick(r, [true, false, null, "true"]),
    defects: pick(r, [[], [sentence(r)], [sentence(r), null, "", sentence(r)], sentence(r), undefined, 7]),
  };
}

for (let i = 0; i < 300; i++) {
  test(`decide property #${i}`, () => {
    const r = rng(50000 + i);
    const n = int(r, 1, 8);
    const criteria = Array.from({ length: n }, () => sentence(r));
    const labels = r() < 0.3 ? { candidate: "A", champion: null } : r() < 0.5 ? { candidate: "A", champion: "B" } : { candidate: "B", champion: "A" };
    const input = { critic: randomCritic(r, n), criteria, labels, hasBar: r() < 0.4, allowTie: r() < 0.3 };
    const expected = oracle(input);
    const result = decide(input);
    assert.equal(result.verdict, expected.pass ? "pass" : "fail", result.reason);
    assert.equal(result.promote, expected.promote);
    assert.ok(result.reason.length <= 1800);
    if (!expected.pass) {
      const listed = [...result.reason.matchAll(/(c\d+) "/g)].map((m) => m[1]);
      if (result.reason.length < 1790) assert.deepEqual(listed, expected.failedIds);
      assert.equal(result.reason.includes("regressed"), !expected.won);
      assert.equal(result.reason.includes("quality bar"), !expected.bar);
    } else {
      assert.match(result.reason, /^critic approved \d+ requirement\(s\)/);
    }
  });
}

const decideCases = [
  {
    name: "missing critic criteria fails every requirement",
    input: { critic: { pick: "A" }, criteria: ["a", "b"], labels: { candidate: "A", champion: null }, hasBar: false, allowTie: false },
    verdict: "fail",
  },
  {
    name: "tie without allowTie is a regression",
    input: { critic: { criteria: [{ id: "c1", pass: true }], pick: "tie" }, criteria: ["a"], labels: { candidate: "A", champion: "B" }, hasBar: false, allowTie: false },
    verdict: "fail",
  },
  {
    name: "tie with allowTie passes but does not promote",
    input: { critic: { criteria: [{ id: "c1", pass: true }], pick: "tie" }, criteria: ["a"], labels: { candidate: "A", champion: "B" }, hasBar: false, allowTie: true },
    verdict: "pass",
    promote: false,
  },
  {
    name: "string defects are reported",
    input: { critic: { criteria: [], pick: "A", defects: "one big defect" }, criteria: ["a"], labels: { candidate: "A", champion: null }, hasBar: false, allowTie: false },
    verdict: "fail",
    reason: /defects: one big defect/,
  },
  {
    name: "pass entry for the champion version does not count",
    input: { critic: { criteria: [{ id: "c1", version: "B", pass: true }], pick: "A" }, criteria: ["a"], labels: { candidate: "A", champion: "B" }, hasBar: false, allowTie: false },
    verdict: "fail",
  },
  {
    name: "lowercase labels are accepted",
    input: { critic: { criteria: [{ id: "c1", version: "b", pass: true }], pick: "b" }, criteria: ["a"], labels: { candidate: "B", champion: "A" }, hasBar: false, allowTie: false },
    verdict: "pass",
    promote: true,
  },
  {
    name: "bar must be strictly true",
    input: { critic: { criteria: [{ id: "c1", pass: true }], pick: "A", beats_bar: "true" }, criteria: ["a"], labels: { candidate: "A", champion: null }, hasBar: true, allowTie: false },
    verdict: "fail",
    reason: /quality bar/,
  },
  {
    name: "defects are capped at five",
    input: { critic: { criteria: [], pick: "A", defects: ["d1", "d2", "d3", "d4", "d5", "d6"] }, criteria: ["a"], labels: { candidate: "A", champion: null }, hasBar: false, allowTie: false },
    verdict: "fail",
    reason: /d5$/,
  },
  {
    name: "defects are not shown on pass",
    input: { critic: { criteria: [{ id: "c1", pass: true }], pick: "A", defects: ["nit"] }, criteria: ["a"], labels: { candidate: "A", champion: null }, hasBar: false, allowTie: false },
    verdict: "pass",
    reason: /^critic approved 1 requirement\(s\)$/,
  },
  {
    name: "long reasons are truncated",
    input: { critic: { criteria: [], pick: "A", defects: Array.from({ length: 5 }, () => "x".repeat(500)) }, criteria: Array.from({ length: 12 }, () => "y".repeat(200)), labels: { candidate: "A", champion: null }, hasBar: false, allowTie: false },
    verdict: "fail",
    reason: /…$/,
  },
];

for (const c of decideCases) {
  test(`decide: ${c.name}`, () => {
    const result = decide(c.input);
    assert.equal(result.verdict, c.verdict, result.reason);
    if (c.promote !== undefined) assert.equal(result.promote, c.promote);
    if (c.reason) assert.match(result.reason, c.reason);
  });
}
