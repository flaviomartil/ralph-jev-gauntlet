import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { askJev, readTail, recentEvents, redactDeep, redactSecrets } from "../lib/jev.mjs";
import { rng, int, scratchDir } from "./helpers.mjs";

const leaks = [
  ["OpenAI key sk-proj-AbCdEf0123456789AbCdEf0123", "sk-proj-AbCdEf0123456789AbCdEf0123"],
  ["anthropic sk-ant-api03-abcdefghijklmnop_QRST", "sk-ant-api03-abcdefghijklmnop_QRST"],
  ["github ghp_0123456789abcdefghijABCDEFGHIJ", "ghp_0123456789abcdefghijABCDEFGHIJ"],
  ["pat github_pat_11ABCDEFG0123456789_abcdefghijklmnop", "github_pat_11ABCDEFG0123456789_abcdefghijklmnop"],
  ["slack xoxb-123456789012-abcdefghij", "xoxb-123456789012-abcdefghij"],
  ["aws AKIAABCDEFGHIJKLMNOP", "AKIAABCDEFGHIJKLMNOP"],
  ["google AIzaSyA0123456789abcdefghijklmnopqrstu", "AIzaSyA0123456789abcdefghijklmnopqrstu"],
  ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop"],
  ["Authorization: Bearer abcdef0123456789xyz", "abcdef0123456789xyz"],
  ["url https://user:hunter2pass@example.com/repo", "hunter2pass"],
  ["API_KEY=supersecretvalue123", "supersecretvalue123"],
  ["db_password: 'p4ssw0rd-long'", "p4ssw0rd-long"],
  ['"access_token": "tok-9f8e7d6c5b4a"', "tok-9f8e7d6c5b4a"],
  ["TYPESAFE_API_KEY=ts_live_abcdef123456", "ts_live_abcdef123456"],
  ["-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----", "MIIEowIBAAKCAQEA"],
  ["client_secret=AbC123dEf456", "AbC123dEf456"],
];
for (const [text, secret] of leaks) {
  test(`redactSecrets hides ${JSON.stringify(text.slice(0, 30))}`, () => {
    const out = redactSecrets(text);
    assert.ok(!out.includes(secret), out);
    assert.match(out, /REDACTED/);
  });
}

const safe = [
  "12 tests passed, 0 failed",
  "ok 3 - token parser handles empty input",
  "password field shows an error when empty",
  "src/auth/login.ts:42 renders",
  "commit 3a38b59 Add slugify",
  "https://example.com/docs/api-key-rotation",
  "npm test && echo done",
];
for (const text of safe) {
  test(`redactSecrets leaves ${JSON.stringify(text)} alone`, () => {
    assert.equal(redactSecrets(text), text);
  });
}

test("redactDeep walks nested state", () => {
  const out = redactDeep({ a: ["x", { b: "API_KEY=abcdef123456" }], n: 3, t: true, z: null });
  assert.deepEqual(out, { a: ["x", { b: "API_KEY=[REDACTED]" }], n: 3, t: true, z: null });
});

test("askJev redacts the state before it leaves the machine", async () => {
  const saved = { ...process.env };
  const original = globalThis.fetch;
  let body;
  Object.assign(process.env, { TYPESAFE_API_KEY: "k", XDG_CACHE_HOME: scratchDir("cache") });
  globalThis.fetch = async (_, init) => {
    body = init.body;
    return { ok: true, status: 200, json: async () => ({ answers: {} }) };
  };
  try {
    await askJev({ verification_run: { output_tail: "FAIL GITHUB_TOKEN=ghp_0123456789abcdefghijABCDEFGHIJ" }, recent_events: [{ payload: "Bearer abcdef0123456789xyz" }] }, {});
  } finally {
    globalThis.fetch = original;
    process.env = saved;
  }
  assert.ok(!body.includes("ghp_0123456789abcdefghijABCDEFGHIJ"));
  assert.ok(!body.includes("abcdef0123456789xyz"));
  assert.match(body, /REDACTED/);
});

for (let i = 0; i < 30; i++) {
  test(`readTail returns whole lines from the end #${i}`, () => {
    const r = rng(400000 + i);
    const lines = Array.from({ length: int(r, 0, 300) }, (_, k) => `line-${k}-${"x".repeat(int(r, 0, 80))}`);
    const file = join(scratchDir("tail"), "f");
    writeFileSync(file, lines.join("\n") + (lines.length ? "\n" : ""));
    const max = int(r, 1, 4000);
    const out = readTail(file, max).split("\n").filter(Boolean);
    assert.ok(Buffer.byteLength(out.join("\n")) <= max);
    assert.deepEqual(out, lines.slice(lines.length - out.length));
  });
}

test("recentEvents reads only the end of a huge events log", () => {
  const ws = scratchDir("big");
  mkdirSync(join(ws, ".ralph"));
  const line = `${JSON.stringify({ topic: "noise", payload: "y".repeat(1000) })}\n`;
  writeFileSync(join(ws, ".ralph", "events.jsonl"), line.repeat(20000) + `${JSON.stringify({ topic: "last", payload: "z" })}\n`);
  const events = recentEvents(ws, 3);
  assert.equal(events.length, 3);
  assert.equal(events[2].topic, "last");
});
