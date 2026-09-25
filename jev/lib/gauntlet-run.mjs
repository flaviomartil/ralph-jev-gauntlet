import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askJev, envNumber, recentEvents, sh, tail } from "./jev.mjs";
import { assignLabels, criticPrompt, decide, jevQuestions, jevStage, parseCriteria, parseCriticOutput } from "./gauntlet.mjs";

export const CHAMPION_REF = "refs/gauntlet/champion";

export function log(message) {
  process.stderr.write(`ralph-gauntlet-judge: ${message}\n`);
}

function git(ws, args, env = {}) {
  return execFileSync("git", args, { cwd: ws, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } }).trim();
}

function readOptional(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

export function snapshot(ws, workdir) {
  const index = join(workdir, "index");
  const env = { GIT_INDEX_FILE: index };
  const head = sh(ws, "git", ["rev-parse", "-q", "--verify", "HEAD"]);
  if (head) git(ws, ["read-tree", "HEAD"], env);
  git(ws, ["add", "-A", "--", ".", ":(exclude).ralph"], env);
  const tree = git(ws, ["write-tree"], env);
  const author = { GIT_AUTHOR_NAME: "ralph-gauntlet", GIT_AUTHOR_EMAIL: "gauntlet@localhost", GIT_COMMITTER_NAME: "ralph-gauntlet", GIT_COMMITTER_EMAIL: "gauntlet@localhost" };
  return git(ws, ["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", "gauntlet candidate"], author);
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

export function runCritic(prompt, workdir, env = process.env) {
  const [cmd, ...args] = criticCommand(workdir, env);
  const res = spawnSync(cmd, args, {
    cwd: workdir,
    input: prompt,
    encoding: "utf8",
    timeout: envNumber("RALPH_GAUNTLET_CRITIC_TIMEOUT_MS", 600000, env),
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw new Error(`critic '${cmd}' failed: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`critic '${cmd}' exited with ${res.status}: ${tail(res.stderr || "", 300)}`);
  return res.stdout;
}

export function evidence(req, criteria) {
  const ws = req.workspace || process.cwd();
  return {
    objective: String(req.objective || "").slice(0, 3000),
    criteria,
    closed_tasks: (req.closed_tasks || []).slice(-30),
    recent_commits: sh(ws, "git", ["log", "--oneline", "-15"]),
    uncommitted_changes: sh(ws, "git", ["status", "--short"]).slice(0, 2000),
    diff_stat: tail(sh(ws, "git", ["diff", "--stat", "HEAD~5"]), 2000),
    recent_events: recentEvents(ws),
  };
}

export async function runGauntlet(req, env = process.env) {
  const ws = req.workspace || process.cwd();
  const gauntletDir = join(ws, ".ralph", "gauntlet");
  const criteria = parseCriteria({ criteriaFile: readOptional(join(gauntletDir, "criteria.md")), objective: req.objective });
  if (!criteria.length) throw new Error("no requirements found");

  try {
    const answers = await askJev(evidence(req, criteria), jevQuestions(criteria));
    const stage = jevStage(answers, criteria, {
      criterionThreshold: envNumber("RALPH_JEV_CRITERION_THRESHOLD", 0.5, env),
      verifiedThreshold: envNumber("RALPH_JEV_VERIFIED_THRESHOLD", 0.5, env),
    });
    if (!stage.ok) return { verdict: "fail", reason: stage.reason };
  } catch (e) {
    log(`Jev stage skipped (${e.message}), going straight to the critic`);
  }

  const workdir = mkdtempSync(join(env.RALPH_GAUNTLET_WORKDIR || tmpdir(), "ralph-gauntlet-"));
  const worktrees = [];
  try {
    const candidate = snapshot(ws, workdir);
    const champion = sh(ws, "git", ["rev-parse", "-q", "--verify", CHAMPION_REF]);
    const sameTree = champion && sh(ws, "git", ["rev-parse", `${champion}^{tree}`]) === sh(ws, "git", ["rev-parse", `${candidate}^{tree}`]);
    const labels = assignLabels(Boolean(champion) && !sameTree);
    const dirs = {};
    for (const [label, sha] of [[labels.candidate, candidate], [labels.champion, champion]]) {
      if (!label) continue;
      const dir = join(workdir, label);
      git(ws, ["worktree", "add", "--detach", dir, sha]);
      worktrees.push(dir);
      dirs[label] = dir;
    }
    const bar = readOptional(join(gauntletDir, "bar.md")).trim();
    const prompt = criticPrompt({ criteria, dirs: Object.fromEntries(Object.entries(dirs).sort()), bar, verifyHint: env.RALPH_GAUNTLET_VERIFY_HINT });
    const critic = parseCriticOutput(runCritic(prompt, workdir, env));
    const result = decide({ critic, criteria, labels, hasBar: Boolean(bar), allowTie: env.RALPH_GAUNTLET_ALLOW_TIE === "1" });
    if (result.promote) git(ws, ["update-ref", CHAMPION_REF, candidate]);
    return { verdict: result.verdict, reason: result.reason };
  } finally {
    for (const dir of worktrees) sh(ws, "git", ["worktree", "remove", "--force", dir]);
    rmSync(workdir, { recursive: true, force: true });
  }
}
