import assert from "node:assert/strict";
import test from "node:test";
import { MAX_CRITERIA, balancedObjectAt, bulletText, headingText, parseCriteria, parseCriticOutput } from "../lib/gauntlet.mjs";
import { parsePayload } from "../lib/jev.mjs";
import { int, pick, rng } from "./helpers.mjs";

const ALPHABET = [
  ..."abcdefghijklmnopqrstuvwxyz ABCXYZ0123456789",
  ..."-*+#_[]()<>{}:;.,!?\"'`\\/|~^%$@&=",
  "\n", "\n", "\n", "\r\n", "\t", "  ", "é", "ç", "ã", "日本", "🙂", "\u00a0", "\u200b", "\u2028",
  "- ", "* ", "1. ", "- [ ] ", "- [x] ", "## ", "**", "__", "Requirements", "Acceptance criteria", "Critérios de aceite", ":",
];

function garbage(r, min, max) {
  const n = int(r, min, max);
  let out = "";
  for (let i = 0; i < n; i++) out += pick(r, ALPHABET);
  return out;
}

for (let i = 0; i < 250; i++) {
  test(`fuzz parseCriteria invariants #${i}`, () => {
    const r = rng(100000 + i);
    const objective = garbage(r, 0, 400);
    const criteriaFile = r() < 0.3 ? garbage(r, 0, 200) : undefined;
    const out = parseCriteria({ objective, criteriaFile });
    assert.ok(Array.isArray(out));
    assert.ok(out.length <= Math.max(MAX_CRITERIA, 1));
    for (const c of out) {
      assert.equal(typeof c, "string");
      assert.ok(c.length > 0);
      assert.equal(c, c.trim());
      assert.ok(c.length <= 1000 || !c.includes("\n"));
      const source = `${criteriaFile ?? ""}\n${objective}`;
      assert.ok(source.includes(c) || objective.trim().startsWith(c), `criterion not found in input: ${JSON.stringify(c)}`);
    }
    if (!objective.trim() && !out.length) assert.deepEqual(out, []);
    assert.deepEqual(parseCriteria({ objective, criteriaFile }), out);
  });
}

for (let i = 0; i < 100; i++) {
  test(`fuzz bulletText and headingText never throw #${i}`, () => {
    const r = rng(110000 + i);
    for (let k = 0; k < 20; k++) {
      const line = garbage(r, 0, 40).replace(/\r?\n/g, " ");
      const b = bulletText(line);
      const h = headingText(line);
      assert.ok(b === null || (typeof b === "string" && b === b.trim() && b.length > 0));
      assert.ok(h === null || typeof h === "string");
    }
  });
}

function randomJsonValue(r, depth = 0) {
  const kind = int(r, 0, depth > 2 ? 3 : 5);
  if (kind === 0) return garbage(r, 0, 12);
  if (kind === 1) return int(r, -1000, 1000) / 7;
  if (kind === 2) return pick(r, [true, false, null]);
  if (kind === 3) return garbage(r, 0, 6).replace(/[\u2028]/g, "");
  if (kind === 4) return Array.from({ length: int(r, 0, 3) }, () => randomJsonValue(r, depth + 1));
  const obj = {};
  for (let k = 0; k < int(r, 0, 3); k++) obj[`k${k}${garbage(r, 0, 3)}`] = randomJsonValue(r, depth + 1);
  return obj;
}

for (let i = 0; i < 150; i++) {
  test(`fuzz balancedObjectAt extracts any serialized object #${i}`, () => {
    const r = rng(120000 + i);
    const value = { a: randomJsonValue(r), b: randomJsonValue(r) };
    const json = JSON.stringify(value, null, r() < 0.5 ? 2 : 0);
    const prefix = garbage(r, 0, 30).replace(/[{}"]/g, "");
    const suffix = garbage(r, 0, 30);
    const text = `${prefix}${json}${suffix}`;
    assert.equal(balancedObjectAt(text, prefix.length), json);
  });
}

for (let i = 0; i < 150; i++) {
  test(`fuzz parseCriticOutput only returns verdicts or throws its own error #${i}`, () => {
    const r = rng(130000 + i);
    const text = garbage(r, 0, 300);
    try {
      const out = parseCriticOutput(text);
      assert.ok(out && typeof out === "object" && Array.isArray(out.criteria));
    } catch (e) {
      assert.match(e.message, /no verdict JSON/);
    }
  });
}

function mutate(r, text) {
  const ops = int(r, 1, 3);
  let out = text;
  for (let k = 0; k < ops; k++) {
    const pos = int(r, 0, out.length);
    const op = int(r, 0, 3);
    if (op === 0) out = out.slice(0, pos);
    else if (op === 1) out = out.slice(0, pos) + pick(r, ["{", "}", '"', ",", "\\", "]", "[", "x"]) + out.slice(pos);
    else if (op === 2) out = out.slice(0, pos) + out.slice(pos + int(r, 1, 5));
    else out = out.slice(pos) + out.slice(0, pos);
  }
  return out;
}

for (let i = 0; i < 150; i++) {
  test(`fuzz parseCriticOutput on corrupted verdicts #${i}`, () => {
    const r = rng(140000 + i);
    const verdict = { criteria: [{ id: "c1", pass: r() < 0.5, evidence: garbage(r, 0, 20) }], pick: pick(r, ["A", "B", "tie"]), defects: [garbage(r, 0, 20)] };
    const corrupted = mutate(r, JSON.stringify(verdict));
    try {
      const out = parseCriticOutput(corrupted);
      assert.ok(Array.isArray(out.criteria));
      assert.doesNotThrow(() => JSON.stringify(out));
    } catch (e) {
      assert.match(e.message, /no verdict JSON/);
    }
  });
}

const payloadCases = [
  ["", {}],
  ["   \n", {}],
  ["{}", {}],
  ['{"a":1}', { a: 1 }],
  ["null", {}],
  ["[]", {}],
  ["[1,2]", {}],
  ["42", {}],
  ['"text"', {}],
  ["true", {}],
  [" {\"loop\":{\"workspace\":\"/w\"}} ", { loop: { workspace: "/w" } }],
];
for (const [raw, expected] of payloadCases) {
  test(`parsePayload(${JSON.stringify(raw)})`, () => assert.deepEqual(parsePayload(raw), expected));
}
for (const bad of ["{", "not json", "{'a':1}", "{a:1}"]) {
  test(`parsePayload rejects ${JSON.stringify(bad)}`, () => assert.throws(() => parsePayload(bad), SyntaxError));
}
test("parsePayload(undefined) is empty", () => assert.deepEqual(parsePayload(undefined), {}));
