import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function int(r, min, max) {
  return min + Math.floor(r() * (max - min + 1));
}

export function pick(r, items) {
  return items[Math.floor(r() * items.length)];
}

const WORDS = [
  "header", "renders", "before", "paragraph", "test", "passes", "api", "returns", "json", "status", "cache", "invalidates",
  "login", "redirects", "dashboard", "error", "message", "shows", "retry", "backoff", "limit", "export", "csv", "column",
  "sorted", "by", "date", "user", "can", "delete", "draft", "button", "disabled", "while", "saving", "latency", "under",
  "200ms", "coverage", "above", "80%", "migration", "reversible", "log", "contains", "request", "id", "página", "relatório",
];

export function sentence(r, min = 2, max = 8) {
  const n = int(r, min, max);
  const words = [];
  for (let i = 0; i < n; i++) words.push(pick(r, WORDS));
  return words.join(" ");
}

export function scratchDir(prefix) {
  const base = process.env.RALPH_GAUNTLET_TEST_DIR || tmpdir();
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `${prefix}-`));
}

export function git(cwd, args, env = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
      ...env,
    },
  }).trim();
}

export function initRepo(dir, { commit = true } = {}) {
  git(dir, ["init", "-q"]);
  if (commit) git(dir, ["commit", "-q", "--allow-empty", "-m", "init"]);
  return dir;
}
