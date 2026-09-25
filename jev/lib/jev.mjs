import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export function jevConfig(env = process.env) {
  return {
    api: env.JEV_API_URL || "https://api.typesafe.ai/v1/systemone",
    model: env.JEV_MODEL || "jev-latest",
    timeoutMs: envNumber("RALPH_JEV_TIMEOUT_MS", 30000, env),
    cooldownMs: envNumber("JEV_COOLDOWN_MS", 300000, env),
    circuitFile: join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "ralph-jev", "circuit.json"),
  };
}

export function envNumber(name, fallback, env = process.env) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export function readEnvKey(path) {
  if (!path || !existsSync(path)) return null;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*"?([^"\s]+)"?/);
    if (m) return m[1];
  }
  return null;
}

export function loadApiKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  const dir = join(homedir(), ".config", "jev-browser-use");
  const fromDir = readEnvKey(join(dir, ".env"));
  if (fromDir) return fromDir;
  try {
    const cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    return readEnvKey(cfg.envFile);
  } catch {
    return null;
  }
}

export function circuitOpen(now = Date.now()) {
  try {
    const { openUntil } = JSON.parse(readFileSync(jevConfig().circuitFile, "utf8"));
    return now < openUntil;
  } catch {
    return false;
  }
}

export function tripCircuit(reason) {
  const { circuitFile, cooldownMs } = jevConfig();
  mkdirSync(dirname(circuitFile), { recursive: true });
  writeFileSync(circuitFile, JSON.stringify({ openUntil: Date.now() + cooldownMs, reason }));
}

const REDACTIONS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]"],
  [/\b(sk|rk|pk)-(live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{16,}/g, "[REDACTED]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[REDACTED]"],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED]"],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "[REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED JWT]"],
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [REDACTED]"],
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi, "$1[REDACTED]@"],
  [/\b([A-Za-z0-9_.-]*(?:token|secret|password|passwd|pwd|api[_-]?key|private[_-]?key|access[_-]?key|credential|auth)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*)(["']?)[^\s"',;]{4,}\3/gi, "$1$2$3[REDACTED]$3"],
];

export function redactSecrets(text) {
  let out = String(text);
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

export function redactDeep(value) {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
    return out;
  }
  return value;
}

export async function askJev(state, questions) {
  if (circuitOpen()) throw new Error("circuit open");
  const key = loadApiKey();
  if (!key) throw new Error("TYPESAFE_API_KEY not configured");
  const { api, model, timeoutMs } = jevConfig();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(api, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, state: redactDeep(state), questions }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const err = `Jev HTTP ${res.status}`;
      if (res.status === 429 || res.status >= 500) tripCircuit(err);
      throw new Error(err);
    }
    const data = await res.json();
    return data.answers || {};
  } finally {
    clearTimeout(timer);
  }
}

export function noul(answers, id) {
  const value = answers?.[id]?.noul;
  if (typeof value !== "number") throw new Error(`Jev response missing noul '${id}'`);
  return value;
}

export function parsePayload(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return {};
  const parsed = JSON.parse(text);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

export function readStdinJson() {
  return parsePayload(readFileSync(0, "utf8"));
}

export function sh(cwd, cmd, args) {
  try {
    return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 }).trim();
  } catch {
    return "";
  }
}

export function tail(text, max) {
  return text.length > max ? text.slice(text.length - max) : text;
}

const EVENTS_TAIL_BYTES = 256 * 1024;

export function readTail(path, maxBytes) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    const text = buf.toString("utf8");
    if (length === size) return text;
    const firstBreak = text.indexOf("\n");
    return firstBreak < 0 ? "" : text.slice(firstBreak + 1);
  } finally {
    closeSync(fd);
  }
}

export function recentEvents(workspace, count = 15) {
  const marker = join(workspace, ".ralph", "current-events");
  const path = existsSync(marker)
    ? resolve(workspace, readFileSync(marker, "utf8").trim())
    : join(workspace, ".ralph", "events.jsonl");
  if (!existsSync(path)) return [];
  return readTail(path, EVENTS_TAIL_BYTES)
    .split("\n")
    .filter(Boolean)
    .slice(-count)
    .map((line) => {
      try {
        const e = JSON.parse(line);
        const payload = e.payload === undefined || e.payload === null ? "" : typeof e.payload === "string" ? e.payload : JSON.stringify(e.payload);
        return { topic: e.topic, payload: payload.slice(0, 300) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function registryPrompt(loop) {
  const id = typeof loop?.id === "string" ? loop.id : "";
  const root = typeof loop?.repo_root === "string" ? loop.repo_root : "";
  if (!id || !root) return "";
  const loops = readJson(join(root, ".ralph", "loops.json"))?.loops;
  const entry = Array.isArray(loops) ? loops.find((l) => l?.id === id) : null;
  return entry?.prompt ? String(entry.prompt) : "";
}

export function loopObjective(workspace, loop = {}) {
  const marker = join(workspace, ".ralph", "current-objective.md");
  if (existsSync(marker)) {
    try {
      const text = readFileSync(marker, "utf8");
      if (text.trim()) return text;
    } catch {}
  }
  const lock = join(workspace, ".ralph", "loop.lock");
  if (existsSync(lock)) {
    const prompt = readJson(lock)?.prompt;
    if (prompt) return String(prompt);
  }
  const fromRegistry = registryPrompt(loop);
  if (fromRegistry) return fromRegistry;
  const promptFile = join(workspace, "PROMPT.md");
  return existsSync(promptFile) ? readFileSync(promptFile, "utf8") : "";
}

export function taskCounts(workspace) {
  const path = join(workspace, ".ralph", "agent", "tasks.jsonl");
  const counts = {};
  if (!existsSync(path)) return counts;
  for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
    try {
      const status = JSON.parse(line).status || "unknown";
      counts[status] = (counts[status] || 0) + 1;
    } catch {}
  }
  return counts;
}

export function fail(prefix, error) {
  process.stderr.write(`${prefix}: ${error.message}\n`);
  process.exit(error.message === "circuit open" ? 2 : 1);
}

const activeGroups = new Set();

export function killGroup(child) {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
}

export function killActiveGroups() {
  for (const child of activeGroups) killGroup(child);
  activeGroups.clear();
}

export const EXIT_GRACE_MS = 200;

export function runGroup(command, args, { cwd, env, input = "", timeoutMs, maxOutput = 32 * 1024 * 1024 }) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    } catch (error) {
      resolvePromise({ code: null, signal: null, timedOut: false, error, output: "", stdout: "", stderr: "" });
      return;
    }
    activeGroups.add(child);
    let output = "";
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const append = (chunk) => {
      output += chunk;
      if (output.length > maxOutput) output = output.slice(-maxOutput);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, timeoutMs);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killGroup(child);
      activeGroups.delete(child);
      resolvePromise(result);
    };
    child.stdout.on("data", (c) => {
      append(c);
      stdout += c;
      if (stdout.length > maxOutput) stdout = stdout.slice(-maxOutput);
    });
    child.stderr.on("data", (c) => {
      append(c);
      stderr = tail(stderr + c, 8000);
    });
    child.stdin.on("error", () => {});
    child.on("error", (error) => finish({ code: null, signal: null, timedOut, error, output, stdout, stderr }));
    child.on("exit", (code, signal) => {
      setTimeout(() => setImmediate(() => finish({ code, signal, timedOut, error: null, output, stdout, stderr })), EXIT_GRACE_MS);
    });
    child.on("close", (code, signal) => finish({ code, signal, timedOut, error: null, output, stdout, stderr }));
    child.stdin.end(input);
  });
}

export async function runVerify(ws, env = process.env) {
  const command = String(env.RALPH_JEV_VERIFY_CMD ?? "").trim();
  if (!command) return null;
  const res = await runGroup("sh", ["-c", command], {
    cwd: ws,
    env: { ...process.env, ...env },
    timeoutMs: envNumber("RALPH_JEV_VERIFY_TIMEOUT_MS", 300000, env),
  });
  return {
    command,
    exit_code: res.error || res.timedOut ? null : res.code,
    timed_out: res.timedOut,
    passed: !res.error && !res.timedOut && res.code === 0,
    output_tail: tail(`${res.output}${res.error ? res.error.message : ""}`, 1500),
  };
}

export function verifyFailure(run) {
  if (!run || run.passed) return null;
  const how = run.timed_out ? "timed out" : `exited with ${run.exit_code ?? "an error"}`;
  return `verification command \`${run.command}\` ${how}: ${run.output_tail.replace(/\s+/g, " ").trim().slice(-600)}`;
}
