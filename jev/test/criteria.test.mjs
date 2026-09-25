import assert from "node:assert/strict";
import test from "node:test";
import { MAX_CRITERIA, bulletText, criteriaSection, headingText, parseCriteria } from "../lib/gauntlet.mjs";
import { int, pick, rng, sentence } from "./helpers.mjs";

const bulletCases = [
  ["- plain", "plain"],
  ["* star", "star"],
  ["+ plus", "plus"],
  ["1. numbered", "numbered"],
  ["12) paren", "paren"],
  ["  - indented", "indented"],
  ["\t- tabbed", "tabbed"],
  ["- [ ] open box", "open box"],
  ["- [x] done box", "done box"],
  ["- [X] upper box", "upper box"],
  ["- trailing   ", "trailing"],
  ["- [ ]", null],
  ["- [ ]   ", null],
  ["- [x]", null],
  ["- ", null],
  ["-", null],
  ["---", null],
  ["* * *", null],
  ["- - -", null],
  ["___", null],
  ["-no space", null],
  ["1.no space", null],
  ["3.5 GB of memory", null],
  ["plain prose", null],
  ["# heading", null],
  ["- [ ]x not a box", "[ ]x not a box"],
  ["- `code` item", "`code` item"],
  ["- item with: colon", "item with: colon"],
  ["- Requirements:", "Requirements:"],
];

for (const [line, expected] of bulletCases) {
  test(`bulletText(${JSON.stringify(line)}) is ${JSON.stringify(expected)}`, () => {
    assert.equal(bulletText(line), expected);
  });
}

const headingCases = [
  ["# Title", "Title"],
  ["###### Deep", "Deep"],
  ["## Closed ##", "Closed"],
  ["  ## Indented", "Indented"],
  ["**Bold**", "Bold"],
  ["**Bold:**", "Bold:"],
  ["**Bold**:", "Bold"],
  ["__Under__", "Under"],
  ["#nospace", null],
  ["####### seven", null],
  ["plain", null],
  ["- **bold bullet**", null],
  ["text **bold** text", null],
];

for (const [line, expected] of headingCases) {
  test(`headingText(${JSON.stringify(line)}) is ${JSON.stringify(expected)}`, () => {
    assert.equal(headingText(line), expected);
  });
}

const parseCases = [
  { name: "empty objective", input: { objective: "" }, expected: [] },
  { name: "whitespace objective", input: { objective: "   \n  " }, expected: [] },
  { name: "undefined objective", input: {}, expected: [] },
  { name: "single sentence", input: { objective: "Make it fast" }, expected: ["Make it fast"] },
  { name: "trims whole objective", input: { objective: "\n  Make it fast \n" }, expected: ["Make it fast"] },
  { name: "caps whole objective at 1000 chars", input: { objective: "x".repeat(1500) }, expected: ["x".repeat(1000)] },
  { name: "plain bullets without heading fall back to whole objective", input: { objective: "Do:\n- a\n- b" }, expected: ["Do:\n- a\n- b"] },
  { name: "checkboxes without heading", input: { objective: "Do this\n- [ ] a\n- plain\n- [x] b" }, expected: ["a", "b"] },
  { name: "atx heading section", input: { objective: "Goal\n## Acceptance criteria\n- a\n- b\n## Notes\n- c" }, expected: ["a", "b"] },
  { name: "bold heading section", input: { objective: "Goal\n**Acceptance criteria**\n- a\n- b\n\n**Notes**\n- c" }, expected: ["a", "b"] },
  { name: "label heading section", input: { objective: "Goal\nRequirements:\n- a\n- b\nNotes:\n- c" }, expected: ["a", "b"] },
  { name: "portuguese heading", input: { objective: "Meta\n## Critérios de aceite\n- a\n- b" }, expected: ["a", "b"] },
  { name: "definition of done", input: { objective: "## Definition of Done\n1. a\n2. b" }, expected: ["a", "b"] },
  { name: "case insensitive heading", input: { objective: "## ACCEPTANCE CRITERIA\n- a" }, expected: ["a"] },
  { name: "paragraph ends the section", input: { objective: "## Requirements\n- a\n- b\nThanks for reading.\n- c" }, expected: ["a", "b"] },
  { name: "blank lines inside section", input: { objective: "## Requirements\n- a\n\n- b\n\n\n- c" }, expected: ["a", "b", "c"] },
  { name: "intro prose before first bullet", input: { objective: "## Requirements\nThe following must hold.\n- a\n- b" }, expected: ["a", "b"] },
  { name: "indented continuation lines are skipped", input: { objective: "## Requirements\n- a\n  more about a\n- b" }, expected: ["a", "b"] },
  { name: "nested bullets are criteria too", input: { objective: "## Requirements\n- a\n  - a1\n- b" }, expected: ["a", "a1", "b"] },
  { name: "empty section falls back to checkboxes", input: { objective: "## Requirements\nnone yet\n## Tasks\n- [ ] a" }, expected: ["a"] },
  { name: "empty section falls back to objective", input: { objective: "## Requirements\n## Next" }, expected: ["## Requirements\n## Next"] },
  { name: "bullets before heading are ignored", input: { objective: "- context\n## Requirements\n- a" }, expected: ["a"] },
  { name: "first criteria heading wins", input: { objective: "## Requirements\n- a\n## Acceptance criteria\n- b" }, expected: ["a"] },
  { name: "empty checkbox lines are skipped", input: { objective: "## Requirements\n- [ ]\n- [ ] a" }, expected: ["a"] },
  { name: "horizontal rule is not a criterion", input: { objective: "## Requirements\n- a\n---\n- b" }, expected: ["a"] },
  { name: "caps at MAX_CRITERIA", input: { objective: `## Requirements\n${Array.from({ length: 20 }, (_, i) => `- r${i}`).join("\n")}` }, expected: Array.from({ length: MAX_CRITERIA }, (_, i) => `r${i}`) },
  { name: "criteria file wins over objective", input: { criteriaFile: "- f1\n- f2", objective: "## Requirements\n- a" }, expected: ["f1", "f2"] },
  { name: "criteria file without bullets falls back", input: { criteriaFile: "just prose", objective: "## Requirements\n- a" }, expected: ["a"] },
  { name: "empty criteria file falls back", input: { criteriaFile: "", objective: "x" }, expected: ["x"] },
  { name: "criteria file keeps all bullets across headings", input: { criteriaFile: "# A\n- a\n# B\n- b" }, expected: ["a", "b"] },
  { name: "criteria file caps at MAX_CRITERIA", input: { criteriaFile: Array.from({ length: 15 }, (_, i) => `- f${i}`).join("\n") }, expected: Array.from({ length: MAX_CRITERIA }, (_, i) => `f${i}`) },
  { name: "crlf line endings", input: { objective: "## Requirements\r\n- a\r\n- b\r\n" }, expected: ["a", "b"] },
  { name: "heading mentioning requirements inside a longer title", input: { objective: "## Functional requirements\n- a" }, expected: ["a"] },
  { name: "non criteria heading is ignored", input: { objective: "## Notes\n- a\n- b" }, expected: ["## Notes\n- a\n- b"] },
];

for (const c of parseCases) {
  test(`parseCriteria: ${c.name}`, () => {
    assert.deepEqual(parseCriteria(c.input), c.expected);
  });
}

test("criteriaSection returns null without a criteria heading", () => {
  assert.equal(criteriaSection(["# Notes", "- a"]), null);
});

const TITLES = ["Acceptance criteria", "Acceptance Criteria", "Critérios de aceite", "Criterios de aceite", "Definition of Done", "Requirements", "Requisitos", "Functional requirements"];
const STYLES = ["- ", "* ", "+ ", "1. ", "2) ", "- [ ] ", "- [x] ", "* [X] ", "10. "];

function headingLine(r, title) {
  const kind = int(r, 0, 3);
  if (kind === 0) return `${"#".repeat(int(r, 1, 6))} ${title}`;
  if (kind === 1) return `**${title}**${r() < 0.5 ? ":" : ""}`;
  if (kind === 2) return `${title}:`;
  return `__${title}__`;
}

function terminator(r) {
  const kind = int(r, 0, 3);
  if (kind === 0) return [`## Notes`, `- ${sentence(r)}`];
  if (kind === 1) return [`Thanks, ${sentence(r)}.`, `- ${sentence(r)}`];
  if (kind === 2) return [`**Notes**`, `- ${sentence(r)}`];
  return [];
}

for (let i = 0; i < 220; i++) {
  test(`parseCriteria property: objective section #${i}`, () => {
    const r = rng(1000 + i);
    const n = int(r, 1, 16);
    const texts = Array.from({ length: n }, () => sentence(r));
    const lines = [sentence(r, 3, 10)];
    if (r() < 0.5) lines.push(`- ${sentence(r)}`);
    if (r() < 0.5) lines.push("");
    lines.push(headingLine(r, pick(r, TITLES)));
    if (r() < 0.3) lines.push("The following must hold.");
    for (const text of texts) {
      if (r() < 0.2) lines.push("");
      lines.push(`${r() < 0.2 ? "  " : ""}${pick(r, STYLES)}${text}${r() < 0.2 ? "  " : ""}`);
    }
    if (r() < 0.3) lines.push("");
    lines.push(...terminator(r));
    const eol = r() < 0.15 ? "\r\n" : "\n";
    assert.deepEqual(parseCriteria({ objective: lines.join(eol) }), texts.slice(0, MAX_CRITERIA));
  });
}

for (let i = 0; i < 100; i++) {
  test(`parseCriteria property: criteria file #${i}`, () => {
    const r = rng(5000 + i);
    const lines = [];
    const expected = [];
    const total = int(r, 1, 25);
    for (let k = 0; k < total; k++) {
      const kind = int(r, 0, 3);
      if (kind === 0) lines.push(`# ${sentence(r, 1, 3)}`);
      else if (kind === 1) lines.push(sentence(r));
      else {
        const text = sentence(r);
        expected.push(text);
        lines.push(`${pick(r, STYLES)}${text}`);
      }
    }
    const result = parseCriteria({ criteriaFile: lines.join("\n"), objective: "## Requirements\n- ignored" });
    if (expected.length) assert.deepEqual(result, expected.slice(0, MAX_CRITERIA));
    else assert.deepEqual(result, ["ignored"]);
  });
}

for (let i = 0; i < 60; i++) {
  test(`parseCriteria property: checkbox fallback #${i}`, () => {
    const r = rng(9000 + i);
    const lines = [sentence(r)];
    const expected = [];
    const total = int(r, 1, 18);
    for (let k = 0; k < total; k++) {
      const kind = int(r, 0, 2);
      const text = sentence(r);
      if (kind === 0) {
        expected.push(text);
        lines.push(`${pick(r, ["- [ ] ", "- [x] ", "* [X] ", "+ [ ] ", "1. [ ] "])}${text}`);
      } else if (kind === 1) lines.push(`- ${text}`);
      else lines.push(text);
    }
    const objective = lines.join("\n");
    const result = parseCriteria({ objective });
    if (expected.length) assert.deepEqual(result, expected.slice(0, MAX_CRITERIA));
    else assert.deepEqual(result, [objective.trim().slice(0, 1000)]);
  });
}
