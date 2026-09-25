import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { askJev, envNumber, killActiveGroups, recentEvents, runGroup, runVerify, sh, tail, verifyFailure } from "./jev.mjs";
import { assignLabels, criticPrompt, decide, jevQuestions, jevStage, parseCriteria, parseCriticOutput } from "./gauntlet.mjs";

export function championRef(loopId, criteria) {
  const id = String(loopId || "primary");
  const idHash = createHash("sha256").update(id).digest("hex").slice(0, 8);
  const loop = `loop-${id.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 60)}-${idHash}`;
  const digest = createHash("sha256").update(JSON.stringify(criteria)).digest("hex").slice(0, 16);
  return `refs/gauntlet/${loop}/${digest}`;
}

export function promoteChampion(ws, ref, candidate, expected) {
  const old = expected || "0".repeat(candidate.length);
  try {
    git(ws, ["update-ref", ref, candidate, old]);
    return true;
  } catch {
    return sh(ws, "git", ["rev-parse", "-q", "--verify", ref]) === candidate;
  }
}

export function log(message) {
  process.stderr.write(`ralph-gauntlet-judge: ${message}\n`);
}

function git(ws, args, env = {}, input) {
  return execFileSync("git", args, {
    cwd: ws,
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    env: { ...process.env, GIT_LITERAL_PATHSPECS: "1", ...env },
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

function readOptional(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

const SECRET_PATTERNS = [
  /(^|\/)\.env(\.[^/]*)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|tfstate|tfstate\.backup)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|\/)\.(npmrc|netrc|pypirc|pgpass|git-credentials)$/i,
  /(^|\/)(credentials|secrets?)(\.[^/]*)?$/i,
];
const SECRET_DIRS = /(^|\/)(\.aws|\.ssh|\.gnupg|\.?secrets?|\.?credentials|\.?private)\//i;
const SAFE_EXAMPLES = /(^|\/)\.env\.(example|sample|template|dist)$/i;

export function isSecretLike(path) {
  if (SECRET_DIRS.test(path)) return true;
  return !SAFE_EXAMPLES.test(path) && SECRET_PATTERNS.some((re) => re.test(path));
}

const FIXED_DATE = "2000-01-01T00:00:00+0000";
const IDENTITY = {
  GIT_AUTHOR_NAME: "ralph-gauntlet",
  GIT_AUTHOR_EMAIL: "gauntlet@localhost",
  GIT_COMMITTER_NAME: "ralph-gauntlet",
  GIT_COMMITTER_EMAIL: "gauntlet@localhost",
  GIT_AUTHOR_DATE: FIXED_DATE,
  GIT_COMMITTER_DATE: FIXED_DATE,
};

export function snapshot(ws, workdir, onExcluded = () => {}) {
  const top = git(ws, ["rev-parse", "--show-toplevel"]);
  const env = { GIT_INDEX_FILE: join(workdir, "index") };
  const head = sh(top, "git", ["rev-parse", "-q", "--verify", "HEAD"]);
  if (head) {
    git(top, ["read-tree", "HEAD"], env);
    const changed = git(top, ["diff-files", "--name-only", "-z"], env)
      .split("\0")
      .filter((p) => p && p !== ".ralph" && !p.startsWith(".ralph/") && !isSecretLike(p));
    if (changed.length) git(top, ["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], env, `${changed.join("\0")}\0`);
  }
  const staged = head
    ? git(top, ["diff", "--cached", "--name-only", "-z", "--diff-filter=AR", "HEAD"]).split("\0").filter(Boolean)
    : git(top, ["ls-files", "--cached", "-z"]).split("\0").filter(Boolean);
  const untracked = [...new Set([...git(top, ["ls-files", "--others", "--exclude-standard", "-z"], env).split("\0").filter(Boolean), ...staged])];
  const excluded = [];
  const keep = untracked.filter((p) => {
    if (p === ".ralph" || p.startsWith(".ralph/")) return false;
    if (isSecretLike(p)) {
      excluded.push(p);
      return false;
    }
    return true;
  });
  if (excluded.length) onExcluded(excluded);
  if (keep.length) git(top, ["add", "-f", "--pathspec-from-file=-", "--pathspec-file-nul"], env, `${keep.join("\0")}\0`);
  const tree = git(top, ["write-tree"], env);
  return git(top, ["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", "gauntlet attempt"], IDENTITY);
}

function unsafeLink(root, path) {
  let target;
  try {
    target = readlinkSync(join(root, path));
  } catch {
    return false;
  }
  if (isAbsolute(target)) return true;
  const resolved = resolve(dirname(join(root, path)), target);
  const rel = relative(root, resolved);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) || isSecretLike(rel);
}

export function exportTree(ws, sha, dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync("sh", ["-c", 'git archive --format=tar "$1" | tar -x -C "$2"', "sh", sha, dir], { cwd: ws, stdio: ["ignore", "ignore", "pipe"] });
  const hidden = [];
  for (const entry of git(ws, ["ls-tree", "-r", "-z", sha]).split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    const meta = entry.slice(0, tab);
    const path = entry.slice(tab + 1);
    const isLink = meta.startsWith("120000 ");
    const loopState = path === ".ralph" || path.startsWith(".ralph/");
    if (loopState || isSecretLike(path) || (isLink && unsafeLink(dir, path))) {
      rmSync(join(dir, path), { force: true, recursive: true });
      hidden.push(path);
    }
  }
  rmSync(join(dir, ".ralph"), { recursive: true, force: true });
  return hidden;
}

export function criticCommand(workdir, env = process.env) {
  if (env.RALPH_GAUNTLET_CRITIC_CMD) {
    const argv = JSON.parse(env.RALPH_GAUNTLET_CRITIC_CMD);
    if (!Array.isArray(argv) || !argv.length || !argv.every((a) => typeof a === "string")) {
      throw new Error("RALPH_GAUNTLET_CRITIC_CMD must be a non-empty JSON array of strings");
    }
    return argv;
  }
  const critic = env.RALPH_GAUNTLET_CRITIC || "claude";
  if (critic !== "claude" && critic !== "codex") throw new Error(`unknown RALPH_GAUNTLET_CRITIC '${critic}'`);
  if (critic === "codex") return ["codex", "exec", "--skip-git-repo-check", "-s", "workspace-write", "-C", workdir, "-"];
  return ["claude", "-p", "--permission-mode", "bypassPermissions", "--add-dir", workdir];
}

const SECRET_ENV = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL|ACCESS_?KEY|SESSION_?KEY|(^|_)AUTH($|_))/i;
const CRITIC_AUTH_PREFIXES = { claude: ["ANTHROPIC_", "CLAUDE_"], codex: ["OPENAI_", "CODEX_"] };

export function criticEnv(env = process.env) {
  const keep = new Set(String(env.RALPH_GAUNTLET_CRITIC_ENV_KEEP ?? "").split(",").map((k) => k.trim()).filter(Boolean));
  const prefixes = env.RALPH_GAUNTLET_CRITIC_CMD ? [] : CRITIC_AUTH_PREFIXES[env.RALPH_GAUNTLET_CRITIC || "claude"] || [];
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const critical = prefixes.some((p) => key.startsWith(p));
    if (SECRET_ENV.test(key) && !critical && !keep.has(key)) continue;
    out[key] = value;
  }
  return out;
}

export async function runCritic(prompt, workdir, env = process.env) {
  const [cmd, ...args] = criticCommand(workdir, env);
  const timeoutMs = envNumber("RALPH_GAUNTLET_CRITIC_TIMEOUT_MS", 600000, env);
  const res = await runGroup(cmd, args, {
    cwd: workdir,
    env: criticEnv({ ...process.env, ...env }),
    input: prompt,
    timeoutMs,
    maxOutput: 64 * 1024 * 1024,
  });
  if (res.error) throw new Error(`critic '${cmd}' failed: ${res.error.message}`);
  if (res.timedOut) throw new Error(`critic '${cmd}' failed: timed out after ${timeoutMs}ms`);
  if (res.code !== 0) throw new Error(`critic '${cmd}' exited with ${res.code ?? res.signal}: ${tail(res.stderr, 300)}`);
  return res.stdout;
}

export function evidence(req, criteria, verification = null) {
  const ws = req.workspace || process.cwd();
  return {
    objective: String(req.objective || "").slice(0, 3000),
    criteria,
    closed_tasks: (req.closed_tasks || []).slice(-30),
    recent_commits: sh(ws, "git", ["log", "--oneline", "-15"]),
    uncommitted_changes: sh(ws, "git", ["status", "--short"]).slice(0, 2000),
    diff_stat: tail(sh(ws, "git", ["diff", "--stat", "HEAD~5"]), 2000),
    recent_events: recentEvents(ws),
    verification_run: verification,
  };
}

const active = new Set();
const STALE_MS = 2 * 60 * 60 * 1000;

export function cleanupActive() {
  killActiveGroups();
  for (const dir of active) rmSync(dir, { recursive: true, force: true });
  active.clear();
}

const OWNER_FILE = ".owner.json";

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

export function claimWorkdir(dir) {
  writeFileSync(join(dir, OWNER_FILE), JSON.stringify({ pid: process.pid, host: hostname(), started: Date.now() }));
}

export function sweepStale(base, now = Date.now()) {
  let removed = 0;
  let entries = [];
  try {
    entries = readdirSync(base);
  } catch {
    return 0;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  for (const name of entries) {
    if (!name.startsWith("ralph-gauntlet-")) continue;
    const path = join(base, name);
    try {
      const st = statSync(path);
      if (!st.isDirectory() || (uid !== null && st.uid !== uid)) continue;
      let owner = null;
      try {
        owner = JSON.parse(readFileSync(join(path, OWNER_FILE), "utf8"));
      } catch {}
      const orphaned = owner && Number.isInteger(owner.pid) && owner.host === hostname() ? !processAlive(owner.pid) : now - st.mtimeMs > STALE_MS;
      if (orphaned) {
        rmSync(path, { recursive: true, force: true });
        removed++;
      }
    } catch {}
  }
  return removed;
}

export async function runGauntlet(req, env = process.env) {
  const ws = req.workspace || process.cwd();
  const gauntletDir = join(ws, ".ralph", "gauntlet");
  const criteria = parseCriteria({ criteriaFile: readOptional(join(gauntletDir, "criteria.md")), objective: req.objective });
  if (!criteria.length) throw new Error("no requirements found");

  const verification = await runVerify(ws, env);
  const verifyFailed = verifyFailure(verification);
  if (verifyFailed) return { verdict: "fail", reason: verifyFailed };

  try {
    const answers = await askJev(evidence(req, criteria, verification), jevQuestions(criteria));
    const stage = jevStage(answers, criteria, {
      criterionThreshold: envNumber("RALPH_JEV_CRITERION_THRESHOLD", 0.5, env),
      verifiedThreshold: envNumber("RALPH_JEV_VERIFIED_THRESHOLD", 0.5, env),
    });
    if (!stage.ok) return { verdict: "fail", reason: stage.reason };
  } catch (e) {
    log(`Jev stage skipped (${e.message}), going straight to the critic`);
  }

  const base = env.RALPH_GAUNTLET_WORKDIR || tmpdir();
  sweepStale(base);
  const workdir = mkdtempSync(join(base, "ralph-gauntlet-"));
  active.add(workdir);
  claimWorkdir(workdir);
  try {
    const candidate = snapshot(ws, workdir, (paths) => log(`left ${paths.length} untracked secret-like file(s) out of the snapshot: ${paths.slice(0, 5).join(", ")}`));
    const ref = championRef(req.loop_id, criteria);
    const champion = sh(ws, "git", ["rev-parse", "-q", "--verify", ref]);
    const sameTree = champion && sh(ws, "git", ["rev-parse", `${champion}^{tree}`]) === sh(ws, "git", ["rev-parse", `${candidate}^{tree}`]);
    const labels = assignLabels(Boolean(champion) && !sameTree);
    const versions = mkdtempSync(join(workdir, "v-"));
    const dirs = {};
    const shas = { [labels.candidate]: candidate };
    if (labels.champion) shas[labels.champion] = champion;
    for (const label of Object.keys(shas).sort()) {
      dirs[label] = join(versions, label);
      exportTree(ws, shas[label], dirs[label]);
    }
    const bar = readOptional(join(gauntletDir, "bar.md")).trim();
    const verifyHint = env.RALPH_GAUNTLET_VERIFY_HINT || String(env.RALPH_JEV_VERIFY_CMD ?? "").trim() || undefined;
    const prompt = criticPrompt({ criteria, dirs: Object.fromEntries(Object.entries(dirs).sort()), bar, verifyHint });
    const critic = parseCriticOutput(await runCritic(prompt, versions, env));
    const result = decide({ critic, criteria, labels, hasBar: Boolean(bar), allowTie: env.RALPH_GAUNTLET_ALLOW_TIE === "1" });
    if (result.promote && !promoteChampion(ws, ref, candidate, champion)) {
      return { verdict: "fail", reason: "another gauntlet judge replaced the best attempt while this one was judged; judging again next time" };
    }
    return { verdict: result.verdict, reason: result.reason };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
    active.delete(workdir);
  }
}
