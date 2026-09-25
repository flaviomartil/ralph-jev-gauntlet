import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
      body: JSON.stringify({ model, state, questions }),
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

export function recentEvents(workspace, count = 15) {
  const marker = join(workspace, ".ralph", "current-events");
  const path = existsSync(marker)
    ? resolve(workspace, readFileSync(marker, "utf8").trim())
    : join(workspace, ".ralph", "events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
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

export function loopObjective(workspace) {
  const lock = join(workspace, ".ralph", "loop.lock");
  if (existsSync(lock)) {
    try {
      const { prompt } = JSON.parse(readFileSync(lock, "utf8"));
      if (prompt) return String(prompt);
    } catch {}
  }
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
