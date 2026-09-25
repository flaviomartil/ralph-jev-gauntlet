import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { askJev, circuitOpen, envNumber, jevConfig, loadApiKey, loopObjective, noul, readEnvKey, recentEvents, tail, taskCounts, tripCircuit } from "../lib/jev.mjs";
import { int, pick, rng, scratchDir, sentence } from "./helpers.mjs";

const envCases = [
  [undefined, 7, 7],
  ["", 7, 7],
  ["   ", 7, 7],
  ["\t", 7, 7],
  ["0", 7, 0],
  ["0.25", 7, 0.25],
  ["-3", 7, -3],
  ["1e3", 7, 1000],
  [" 12 ", 7, 12],
  ["abc", 7, 7],
  ["12abc", 7, 7],
  ["NaN", 7, 7],
  ["Infinity", 7, 7],
  ["-Infinity", 7, 7],
  ["0x10", 7, 16],
  [".5", 7, 0.5],
  ["5.", 7, 5],
  ["1,5", 7, 7],
];
for (const [raw, fallback, expected] of envCases) {
  test(`envNumber(${JSON.stringify(raw)}) -> ${expected}`, () => {
    assert.equal(envNumber("X", fallback, raw === undefined ? {} : { X: raw }), expected);
  });
}

for (let i = 0; i < 40; i++) {
  test(`envNumber property #${i}`, () => {
    const r = rng(60000 + i);
    const value = Math.round((r() - 0.5) * 1e6) / 100;
    assert.equal(envNumber("V", 1, { V: String(value) }), value);
  });
}

test("jevConfig defaults", () => {
  const cfg = jevConfig({ XDG_CACHE_HOME: "/c" });
  assert.equal(cfg.api, "https://api.typesafe.ai/v1/systemone");
  assert.equal(cfg.model, "jev-latest");
  assert.equal(cfg.timeoutMs, 30000);
  assert.equal(cfg.cooldownMs, 300000);
  assert.equal(cfg.circuitFile, "/c/ralph-jev/circuit.json");
});

test("jevConfig overrides", () => {
  const cfg = jevConfig({ JEV_API_URL: "http://x", JEV_MODEL: "m", RALPH_JEV_TIMEOUT_MS: "5", JEV_COOLDOWN_MS: "9", XDG_CACHE_HOME: "/d" });
  assert.deepEqual(cfg, { api: "http://x", model: "m", timeoutMs: 5, cooldownMs: 9, circuitFile: "/d/ralph-jev/circuit.json" });
});

for (let i = 0; i < 30; i++) {
  test(`tail property #${i}`, () => {
    const r = rng(61000 + i);
    const text = sentence(r, 0, 40);
    const max = int(r, 0, 120);
    const out = tail(text, max);
    assert.ok(out.length <= Math.max(max, 0) || text.length <= max);
    assert.ok(text.endsWith(out));
    if (text.length <= max) assert.equal(out, text);
  });
}

const keyCases = [
  ["TYPESAFE_API_KEY=abc", "abc"],
  ["export TYPESAFE_API_KEY=abc", "abc"],
  ['TYPESAFE_API_KEY="abc"', "abc"],
  ["  TYPESAFE_API_KEY = abc  ", "abc"],
  ["OTHER=1\nTYPESAFE_API_KEY=second", "second"],
  ["# TYPESAFE_API_KEY=commented", null],
  ["TYPESAFE_API_KEY=", null],
  ["TYPESAFE_API_KEY_OLD=nope", null],
  ["XTYPESAFE_API_KEY=nope", null],
  ["TYPESAFE_API_KEY=first\nTYPESAFE_API_KEY=second", "first"],
  ["", null],
];
for (const [content, expected] of keyCases) {
  test(`readEnvKey(${JSON.stringify(content)})`, () => {
    const dir = scratchDir("envkey");
    const file = join(dir, ".env");
    writeFileSync(file, content);
    assert.equal(readEnvKey(file), expected);
  });
}

test("readEnvKey handles missing path", () => {
  assert.equal(readEnvKey(null), null);
  assert.equal(readEnvKey("/definitely/not/here"), null);
});

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  const restore = () => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
  try {
    const out = fn();
    if (out && typeof out.then === "function") return out.finally(restore);
    restore();
    return out;
  } catch (e) {
    restore();
    throw e;
  }
}

test("loadApiKey prefers the environment", () => {
  withEnv({ TYPESAFE_API_KEY: "from-env", HOME: scratchDir("home") }, () => assert.equal(loadApiKey(), "from-env"));
});

test("loadApiKey reads ~/.config/jev-browser-use/.env", () => {
  const home = scratchDir("home");
  mkdirSync(join(home, ".config", "jev-browser-use"), { recursive: true });
  writeFileSync(join(home, ".config", "jev-browser-use", ".env"), "TYPESAFE_API_KEY=dotenv");
  withEnv({ TYPESAFE_API_KEY: undefined, HOME: home }, () => assert.equal(loadApiKey(), "dotenv"));
});

test("loadApiKey follows config.json envFile", () => {
  const home = scratchDir("home");
  const dir = join(home, ".config", "jev-browser-use");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(home, "k.env"), "export TYPESAFE_API_KEY=viaconfig");
  writeFileSync(join(dir, "config.json"), JSON.stringify({ envFile: join(home, "k.env") }));
  withEnv({ TYPESAFE_API_KEY: undefined, HOME: home }, () => assert.equal(loadApiKey(), "viaconfig"));
});

test("loadApiKey returns null when nothing is configured", () => {
  withEnv({ TYPESAFE_API_KEY: undefined, HOME: scratchDir("home") }, () => assert.equal(loadApiKey(), null));
});

test("loadApiKey tolerates a broken config.json", () => {
  const home = scratchDir("home");
  mkdirSync(join(home, ".config", "jev-browser-use"), { recursive: true });
  writeFileSync(join(home, ".config", "jev-browser-use", "config.json"), "{broken");
  withEnv({ TYPESAFE_API_KEY: undefined, HOME: home }, () => assert.equal(loadApiKey(), null));
});

test("circuit starts closed, trips open, and expires", () => {
  const cache = scratchDir("cache");
  withEnv({ XDG_CACHE_HOME: cache, JEV_COOLDOWN_MS: "60000" }, () => {
    assert.equal(circuitOpen(), false);
    tripCircuit("Jev HTTP 429");
    assert.equal(circuitOpen(), true);
    assert.equal(circuitOpen(Date.now() + 61000), false);
  });
});

test("circuit tolerates a corrupt state file", () => {
  const cache = scratchDir("cache");
  mkdirSync(join(cache, "ralph-jev"), { recursive: true });
  writeFileSync(join(cache, "ralph-jev", "circuit.json"), "nope");
  withEnv({ XDG_CACHE_HOME: cache }, () => assert.equal(circuitOpen(), false));
});

function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return handler(url, init);
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const statusCases = [
  [200, false, null],
  [400, false, "Jev HTTP 400"],
  [401, false, "Jev HTTP 401"],
  [403, false, "Jev HTTP 403"],
  [404, false, "Jev HTTP 404"],
  [422, false, "Jev HTTP 422"],
  [429, true, "Jev HTTP 429"],
  [500, true, "Jev HTTP 500"],
  [502, true, "Jev HTTP 502"],
  [503, true, "Jev HTTP 503"],
  [504, true, "Jev HTTP 504"],
];
for (const [status, trips, error] of statusCases) {
  test(`askJev status ${status}`, async () => {
    const cache = scratchDir("cache");
    const stub = stubFetch(() => response(status, { answers: { x: { noul: 0.7 } } }));
    try {
      await withEnv({ XDG_CACHE_HOME: cache, TYPESAFE_API_KEY: "k", JEV_API_URL: "http://jev.test/v1", JEV_MODEL: "m1" }, async () => {
        if (error) await assert.rejects(askJev({ s: 1 }, { x: { type: "noul" } }), new RegExp(error));
        else assert.deepEqual(await askJev({ s: 1 }, { x: { type: "noul" } }), { x: { noul: 0.7 } });
        assert.equal(circuitOpen(), trips);
        assert.equal(stub.calls[0].url, "http://jev.test/v1");
        assert.deepEqual(stub.calls[0].body, { model: "m1", state: { s: 1 }, questions: { x: { type: "noul" } } });
        assert.equal(stub.calls[0].init.headers.Authorization, "Bearer k");
      });
    } finally {
      stub.restore();
    }
  });
}

test("askJev returns {} when the response has no answers", async () => {
  const stub = stubFetch(() => response(200, {}));
  try {
    await withEnv({ XDG_CACHE_HOME: scratchDir("cache"), TYPESAFE_API_KEY: "k" }, async () => assert.deepEqual(await askJev({}, {}), {}));
  } finally {
    stub.restore();
  }
});

test("askJev refuses while the circuit is open and does not call fetch", async () => {
  const cache = scratchDir("cache");
  const stub = stubFetch(() => response(200, {}));
  try {
    await withEnv({ XDG_CACHE_HOME: cache, TYPESAFE_API_KEY: "k" }, async () => {
      tripCircuit("test");
      await assert.rejects(askJev({}, {}), /circuit open/);
      assert.equal(stub.calls.length, 0);
    });
  } finally {
    stub.restore();
  }
});

test("askJev fails without a key", async () => {
  const stub = stubFetch(() => response(200, {}));
  try {
    await withEnv({ XDG_CACHE_HOME: scratchDir("cache"), TYPESAFE_API_KEY: undefined, HOME: scratchDir("home") }, async () => {
      await assert.rejects(askJev({}, {}), /not configured/);
      assert.equal(stub.calls.length, 0);
    });
  } finally {
    stub.restore();
  }
});

test("askJev network errors do not trip the circuit", async () => {
  const cache = scratchDir("cache");
  const stub = stubFetch(() => {
    throw new Error("ECONNREFUSED");
  });
  try {
    await withEnv({ XDG_CACHE_HOME: cache, TYPESAFE_API_KEY: "k" }, async () => {
      await assert.rejects(askJev({}, {}), /ECONNREFUSED/);
      assert.equal(circuitOpen(), false);
    });
  } finally {
    stub.restore();
  }
});

test("askJev aborts after the timeout", async () => {
  const stub = stubFetch((_, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))));
  try {
    await withEnv({ XDG_CACHE_HOME: scratchDir("cache"), TYPESAFE_API_KEY: "k", RALPH_JEV_TIMEOUT_MS: "20" }, async () => {
      await assert.rejects(askJev({}, {}), /aborted/);
    });
  } finally {
    stub.restore();
  }
});

const noulCases = [
  [{ a: { noul: 0.3 } }, "a", 0.3],
  [{ a: { noul: 0 } }, "a", 0],
  [{ a: { noul: 1 } }, "a", 1],
];
for (const [answers, id, expected] of noulCases) {
  test(`noul(${JSON.stringify(answers)}, ${id})`, () => assert.equal(noul(answers, id), expected));
}
for (const bad of [{}, null, { a: {} }, { a: { noul: "0.3" } }, { a: { choice: "x" } }, { b: { noul: 1 } }]) {
  test(`noul rejects ${JSON.stringify(bad)}`, () => assert.throws(() => noul(bad, "a"), /missing noul 'a'/));
}

function workspace(files) {
  const ws = scratchDir("ws");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(ws, path, ".."), { recursive: true });
    writeFileSync(join(ws, path), content);
  }
  return ws;
}

test("recentEvents is empty without an events file", () => {
  assert.deepEqual(recentEvents(workspace({})), []);
});

test("recentEvents reads the default events file", () => {
  const ws = workspace({ ".ralph/events.jsonl": '{"topic":"a","payload":"x"}\n{"topic":"b"}\n' });
  assert.deepEqual(recentEvents(ws), [
    { topic: "a", payload: "x" },
    { topic: "b", payload: "" },
  ]);
});

test("recentEvents follows the current-events marker", () => {
  const ws = workspace({ ".ralph/current-events": ".ralph/events-1.jsonl\n", ".ralph/events-1.jsonl": '{"topic":"m"}\n', ".ralph/events.jsonl": '{"topic":"default"}\n' });
  assert.deepEqual(recentEvents(ws), [{ topic: "m", payload: "" }]);
});

test("recentEvents with a marker pointing nowhere is empty", () => {
  assert.deepEqual(recentEvents(workspace({ ".ralph/current-events": ".ralph/missing.jsonl" })), []);
});

test("recentEvents skips malformed lines and stringifies payloads", () => {
  const ws = workspace({ ".ralph/events.jsonl": 'not json\n{"topic":"a","payload":{"k":1}}\n{"topic":"b","payload":5}\n' });
  assert.deepEqual(recentEvents(ws), [
    { topic: "a", payload: '{"k":1}' },
    { topic: "b", payload: "5" },
  ]);
});

for (let i = 0; i < 25; i++) {
  test(`recentEvents property #${i}`, () => {
    const r = rng(62000 + i);
    const total = int(r, 0, 40);
    const count = int(r, 1, 20);
    const events = Array.from({ length: total }, (_, k) => ({ topic: `t${k}`, payload: sentence(r, 0, 120) }));
    const ws = workspace({ ".ralph/events.jsonl": events.map((e) => JSON.stringify(e)).join("\n") + (r() < 0.5 ? "\n" : "") });
    const out = recentEvents(ws, count);
    const expected = events.slice(-count).map((e) => ({ topic: e.topic, payload: e.payload.slice(0, 300) }));
    assert.deepEqual(out, expected);
  });
}

test("loopObjective reads the loop lock prompt", () => {
  assert.equal(loopObjective(workspace({ ".ralph/loop.lock": JSON.stringify({ pid: 1, started: "x", prompt: "from lock" }, null, 2), "PROMPT.md": "file" })), "from lock");
});

test("loopObjective falls back to PROMPT.md when the lock is corrupt", () => {
  assert.equal(loopObjective(workspace({ ".ralph/loop.lock": "garbage", "PROMPT.md": "file" })), "file");
});

test("loopObjective falls back to PROMPT.md when the lock has no prompt", () => {
  assert.equal(loopObjective(workspace({ ".ralph/loop.lock": "{}", "PROMPT.md": "file" })), "file");
});

test("loopObjective is empty when nothing exists", () => {
  assert.equal(loopObjective(workspace({})), "");
});

test("taskCounts counts statuses and tolerates junk", () => {
  const lines = ['{"status":"open"}', '{"status":"closed"}', '{"status":"open"}', "junk", "{}", ""].join("\n");
  assert.deepEqual(taskCounts(workspace({ ".ralph/agent/tasks.jsonl": lines })), { open: 2, closed: 1, unknown: 1 });
});

test("taskCounts is empty without a tasks file", () => {
  assert.deepEqual(taskCounts(workspace({})), {});
});

for (let i = 0; i < 20; i++) {
  test(`taskCounts property #${i}`, () => {
    const r = rng(63000 + i);
    const expected = {};
    const lines = [];
    for (let k = 0; k < int(r, 0, 30); k++) {
      const status = pick(r, ["open", "in_progress", "closed", "failed"]);
      expected[status] = (expected[status] || 0) + 1;
      lines.push(JSON.stringify({ id: `t${k}`, title: sentence(r), status }));
    }
    assert.deepEqual(taskCounts(workspace({ ".ralph/agent/tasks.jsonl": lines.join("\n") })), expected);
  });
}
