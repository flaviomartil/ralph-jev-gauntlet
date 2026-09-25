export const MAX_CRITERIA = 12;
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
const CHECKBOX = /^\[[ xX]\](?:\s+|$)/;
const RULE_ONLY = /^[-*_\s]+$/;
const ATX_HEADING = /^\s*#{1,6}\s+(.*?)\s*#*\s*$/;
const BOLD_HEADING = /^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*:?\s*$/;
const LABEL_LINE = /^[^\s\-*+#][^:]*:\s*$/;
const CRITERIA_HEADING = /(acceptance criteria|crit[eé]rios? de aceite|definition of done|requirements|requisitos)/i;

export function bulletText(line) {
  const m = String(line).match(BULLET);
  if (!m) return null;
  const text = m[1].replace(CHECKBOX, "").trim();
  if (!text || RULE_ONLY.test(text) || /^\[[ xX]\]$/.test(text)) return null;
  return text;
}

export function headingText(line) {
  const atx = String(line).match(ATX_HEADING);
  if (atx) return atx[1];
  const bold = String(line).match(BOLD_HEADING);
  return bold ? bold[1] : null;
}

function isLabel(line) {
  return LABEL_LINE.test(line) && bulletText(line) === null;
}

function bullets(lines) {
  return lines.map(bulletText).filter((t) => t !== null);
}

export function criteriaSection(lines) {
  const start = lines.findIndex((l) => {
    const title = headingText(l) ?? (isLabel(l) ? l : null);
    return title !== null && CRITERIA_HEADING.test(title);
  });
  if (start < 0) return null;
  const found = [];
  for (const line of lines.slice(start + 1)) {
    if (headingText(line) !== null || isLabel(line)) break;
    const text = bulletText(line);
    if (text !== null) {
      found.push(text);
      continue;
    }
    if (found.length && line.trim() && !/^\s/.test(line)) break;
  }
  return found;
}

export function parseCriteria({ criteriaFile, objective }) {
  if (criteriaFile) {
    const found = bullets(String(criteriaFile).split(/\r?\n/));
    if (found.length) return found.slice(0, MAX_CRITERIA);
  }
  const lines = String(objective || "").split(/\r?\n/);
  const section = criteriaSection(lines);
  if (section?.length) return section.slice(0, MAX_CRITERIA);
  const checkboxes = lines
    .filter((l) => {
      const m = l.match(BULLET);
      return m && CHECKBOX.test(m[1]);
    })
    .map(bulletText)
    .filter((t) => t !== null);
  if (checkboxes.length) return checkboxes.slice(0, MAX_CRITERIA);
  const text = String(objective || "").trim();
  return text ? [text.slice(0, 1000)] : [];
}

export function jevQuestions(criteria) {
  const questions = {
    verified: {
      type: "noul",
      instructions:
        "Do `recent_events`, `closed_tasks` or `recent_commits` show that the work was checked by running tests, a build, a typecheck or another concrete verification that passed, rather than only being claimed as done?",
    },
  };
  criteria.forEach((_, i) => {
    questions[`c${i + 1}`] = {
      type: "noul",
      instructions: `Does the evidence in the state (commits, changed files, closed tasks and recent events) show that requirement \`criteria[${i}]\` has been fully met in the workspace? Answer false when it is missing, partial, only planned or only described.`,
    };
  });
  return questions;
}

export function jevStage(answers, criteria, { criterionThreshold, verifiedThreshold }) {
  const failing = [];
  criteria.forEach((text, i) => {
    const p = answers?.[`c${i + 1}`]?.noul;
    if (typeof p === "number" && p < criterionThreshold) failing.push({ id: `c${i + 1}`, text, p });
  });
  const verified = answers?.verified?.noul;
  const unverified = typeof verified === "number" && verified < verifiedThreshold;
  if (!failing.length && !unverified) return { ok: true };
  const parts = failing.map((f) => `${f.id} "${truncate(f.text, 120)}" (p=${f.p.toFixed(2)})`);
  if (unverified) parts.push(`no passing verification evidence (verified=${verified.toFixed(2)})`);
  return { ok: false, reason: `Jev: requirements not met: ${parts.join("; ")}` };
}

export function assignLabels(hasChampion, random = Math.random) {
  if (!hasChampion) return { candidate: "A", champion: null };
  return random() < 0.5 ? { candidate: "A", champion: "B" } : { candidate: "B", champion: "A" };
}

export function criticPrompt({ criteria, dirs, bar, verifyHint }) {
  const versions = Object.keys(dirs);
  const list = criteria.map((c, i) => `c${i + 1}. ${c}`).join("\n");
  const dirLines = versions.map((v) => `- Version ${v}: ${dirs[v]}`).join("\n");
  const compare =
    versions.length > 1
      ? `Two versions of the same project follow, labels assigned at random. Judge them blind: do not guess which one is newer.\n${dirLines}\nAfter checking the requirements on both, pick the version that better satisfies them overall. Use "tie" only if they are genuinely indistinguishable.`
      : `The version under review:\n${dirLines}`;
  const barBlock = bar
    ? `\nQuality bar (a real reference the work must beat):\n${bar}\nOpen or fetch the reference and put your preferred version next to it. Set "beats_bar" to true only if the version you picked (Version A when there is only one) is at least as good as the reference on what the requirements ask for.`
    : "";
  return `You are a harsh, independent critic in a gauntlet loop. You did not write this code and owe it nothing.

Requirements:
${list}

${compare}${barBlock}

How to judge:
- Open the files. Run the tests, build or other checks yourself${verifyHint ? ` (${verifyHint})` : ""}. Do not trust claims in commit messages or notes.
- A requirement passes only if you saw evidence that it works. Partial, stubbed or untested counts as fail.
- Do not modify source files. Build artifacts and dependency installs inside the version directories are fine.
- List concrete defects, most important first, each one specific enough to fix.

Finish with exactly one line of JSON and nothing after it:
{"criteria":[{"id":"c1","version":"A","pass":true,"evidence":"..."}],"pick":"A","beats_bar":null,"defects":["..."]}
Report "criteria" for Version A${versions.length > 1 ? " and for Version B (one entry per requirement per version)" : ""}. "pick" is ${versions.length > 1 ? '"A", "B" or "tie"' : '"A"'}. "beats_bar" is ${bar ? "true or false" : "null"}.`;
}

const MAX_PARSE_ATTEMPTS = 5000;

export function balancedObjectAt(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function parseCriticOutput(text) {
  const source = String(text ?? "");
  let attempts = 0;
  for (let i = source.lastIndexOf("{"); i >= 0 && attempts < MAX_PARSE_ATTEMPTS; i = source.lastIndexOf("{", i - 1), attempts++) {
    const candidate = balancedObjectAt(source, i);
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.criteria)) return parsed;
    } catch {}
    if (i === 0) break;
  }
  throw new Error("critic produced no verdict JSON");
}

function label(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : null;
}

export function decide({ critic, criteria, labels, hasBar, allowTie }) {
  const entries = Array.isArray(critic?.criteria) ? critic.criteria.filter((c) => c && typeof c === "object") : [];
  const mine = entries.filter((c) => c.version === undefined || c.version === null || label(c.version) === labels.candidate);
  const failed = criteria
    .map((text, i) => {
      const entry = mine.find((c) => String(c.id ?? "").trim().toLowerCase() === `c${i + 1}`);
      return entry && entry.pass === true ? null : { id: `c${i + 1}`, text, evidence: entry?.evidence ?? "not reported" };
    })
    .filter(Boolean);
  const pick = label(critic?.pick);
  const candidateWon = !labels.champion || pick === labels.candidate || (allowTie === true && pick === "TIE");
  const beatsBar = !hasBar || critic?.beats_bar === true;
  const promote = !labels.champion || pick === labels.candidate;
  const problems = [];
  if (failed.length) {
    problems.push(`critic: requirements failing: ${failed.map((f) => `${f.id} "${truncate(f.text, 80)}" (${truncate(f.evidence, 160)})`).join("; ")}`);
  }
  if (!candidateWon) problems.push("critic: blind comparison preferred the previous best attempt, so this attempt regressed");
  if (!beatsBar) problems.push("critic: does not beat the quality bar yet");
  const rawDefects = Array.isArray(critic?.defects) ? critic.defects : typeof critic?.defects === "string" ? [critic.defects] : [];
  const defects = rawDefects.filter((d) => d !== null && d !== undefined && String(d).trim()).slice(0, 5).map((d) => truncate(String(d), 200));
  if (problems.length && defects.length) problems.push(`defects: ${defects.join(" | ")}`);
  return {
    verdict: problems.length ? "fail" : "pass",
    reason: problems.length ? truncate(problems.join(". "), 1800) : `critic approved ${criteria.length} requirement(s)${labels.champion ? ", beat previous best" : ""}${hasBar ? ", beat the bar" : ""}`,
    promote,
  };
}

export function truncate(text, max) {
  const s = String(text);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
