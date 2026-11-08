import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { assertLocalDatabase, assertLocalOrigin, isolatedEnvironment, assertIsolatedServices, containsContact, summary, stopOwnedChild } from "../scripts/perf/common.js";
const runId = "a".repeat(32);
const uri = `mongodb://127.0.0.1:32123/talkmart_perf_${runId}?replicaSet=perf`;

test("performance harness rejects external, production and unrelated local database targets", () => {
  assert.equal(assertLocalDatabase(uri, runId), "talkmart_perf_" + runId);
  for (const target of ["mongodb+srv://example.com/test", "mongodb://127.0.0.1:27017/test", "mongodb://127.0.0.1:27017/talkmart_staging",
    uri.replace("127.0.0.1", "173.212.232.253"), uri.replace("127.0.0.1", "user:password@127.0.0.1"), uri + "&proxyHost=example.com"]) {
    assert.throws(() => assertLocalDatabase(target, runId));
  }
  assert.throws(() => assertLocalDatabase(uri, "b".repeat(32)));
});

test("performance HTTP client only accepts ephemeral loopback origins", () => {
  assert.equal(assertLocalOrigin("http://127.0.0.1:32123"), "http://127.0.0.1:32123");
  for (const target of ["https://api.talkmart.az", "https://api.talkmart.az/test-api", "http://127.0.0.1:5000", "http://127.0.0.1:5001",
    "http://127.0.0.1", "http://localhost:32123", "http://127.0.0.1:32123/api", "http://user:secret@127.0.0.1:32123"]) assert.throws(() => assertLocalOrigin(target));
});

test("performance children discard caller credentials and reject live service settings", () => {
  const previous = process.env.GEMINI_API_KEY;
  try {
    process.env.GEMINI_API_KEY = "CALLER_SENTINEL_NEVER_INHERIT";
    const env = isolatedEnvironment({ runId, uri, directory: "tmp/owned-perf" });
    assert.ok(!JSON.stringify(env).includes("CALLER_SENTINEL_NEVER_INHERIT"));
    assertIsolatedServices(env);
    assert.throws(() => assertIsolatedServices({ ...env, R2_BUCKET: "talkmart" }));
    assert.throws(() => assertIsolatedServices({ ...env, GEMINI_API_KEY: "unexpected" }));
    assert.throws(() => assertIsolatedServices({ ...env, SMTP_HOST: "smtp.gmail.com" }));
    assert.throws(() => assertIsolatedServices({ ...env, REDIS_DISABLED: "false" }));
    assert.equal(env.NODE_OPTIONS, undefined);
  } finally {
    if (previous === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = previous;
  }
});

test("benchmark percentiles use nearest rank and never label missing samples as zero latency", () => {
  assert.equal(summary([]).p95, null);
  const measured = summary(Array.from({ length: 100 }, (_, index) => index + 1));
  assert.equal(measured.p50, 50); assert.equal(measured.p95, 95); assert.equal(measured.p99, 99);
  assert.equal(containsContact([{ provider: { phone: "synthetic" } }]), true);
  assert.equal(containsContact([{ provider: { fullName: "Synthetic", profileImage: "https://media.invalid/image.webp" } }]), false);
});

test("benchmark cleanup closes its child and also handles a child already killed by a signal", async () => {
  const graceful = spawn(process.execPath, ["-e", "process.on('message', () => process.exit(0))"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  await once(graceful, "spawn");
  try { await stopOwnedChild(graceful); assert.equal(graceful.exitCode, 0); }
  finally { await stopOwnedChild(graceful); }
  const killed = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await once(killed, "spawn");
  const exited = once(killed, "exit");
  killed.kill("SIGKILL");
  await exited;
  assert.notEqual(killed.signalCode, null);
  let timeout;
  try {
    await Promise.race([stopOwnedChild(killed), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("CLEANUP_HUNG")), 1000); })]);
  } finally { clearTimeout(timeout); }
});
