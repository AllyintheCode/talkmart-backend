// Test-only adapters around the actual worker entry point. Never load caller .env.
import mongoose from "mongoose";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { assertIsolatedServices, assertLocalDatabase } from "./common.js";

assertIsolatedServices(process.env);
const reportDirectory = await fs.realpath(process.env.PERF_REPORT_DIRECTORY || ".");
if (path.dirname(reportDirectory) !== await fs.realpath("tmp/performance") ||
    await fs.realpath(os.tmpdir()) !== path.join(reportDirectory, "worker-temp")) throw new Error("PERF_TEMP_DIRECTORY_NOT_OWNED");
if (!process.send || !["approved", "provider503"].includes(process.env.PERF_AI_MODE)) throw new Error("OWNED_WORKER_IPC_REQUIRED");
const name = assertLocalDatabase(process.env.MONGO_URI, process.env.PERF_RUN_ID);
await mongoose.connect(process.env.MONGO_URI, { autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 10000 });
if (mongoose.connection.name !== name || !await mongoose.connection.db.collection("_perf_runs").findOne({ _id: process.env.PERF_RUN_ID, owned: true })) {
  await mongoose.disconnect(); throw new Error("PERF_DATABASE_MARKER_MISSING");
}
await mongoose.disconnect();

let next = 0;
const pending = new Map();
process.on("message", message => {
  if (message?.type === "stop") { process.emit("SIGTERM"); return; }
  if (message?.type !== "storage-result") return;
  const waiting = pending.get(message.id);
  if (!waiting) return;
  pending.delete(message.id);
  if (message.error) waiting.reject(Object.assign(new Error(message.error.code), { code: message.error.code, name: message.error.code }));
  else waiting.resolve(message.result);
});
process.on("disconnect", () => {
  for (const waiting of pending.values()) waiting.reject(new Error("OWNED_STORAGE_DISCONNECTED"));
  pending.clear(); process.emit("SIGTERM");
});
const { default: r2 } = await import("../../src/config/r2.js");
r2.send = async command => {
  const { Body, ...input } = command.input;
  if (Body !== undefined) {
    const chunks = []; let bytes = 0;
    const collect = chunk => { const buffer = Buffer.from(chunk); bytes += buffer.length;
      if (bytes > 2 * 1024 * 1024) throw new Error("PERF_FIXTURE_TOO_LARGE"); chunks.push(buffer); };
    if (Body instanceof Uint8Array) collect(Body); else for await (const chunk of Body) collect(chunk);
    input.bodyBase64 = Buffer.concat(chunks).toString("base64");
  }
  const id = ++next;
  const result = await new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    process.send({ type: "storage", id, command: command.constructor.name, input }, error => {
      if (error) { pending.delete(id); reject(error); }
    });
  });
  if (command.constructor.name === "GetObjectCommand") return { Body: Readable.from(Buffer.from(result.bodyBase64, "base64")) };
  if (result.Contents) result.Contents = result.Contents.map(item => ({ ...item, LastModified: new Date(item.LastModified) }));
  return result;
};

// The SDK, frame extraction, schema parser and retry path remain real. Model/network
// timings are deliberately simulated and cannot be used as a Gemini benchmark.
process.env.GEMINI_API_KEY = "owned-local-model-stub";
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.hostname !== "generativelanguage.googleapis.com" || !url.pathname.endsWith(":generateContent")) throw new Error("PERF_EXTERNAL_FETCH_BLOCKED");
  await delay(250, undefined, { signal: options.signal });
  if (process.env.PERF_AI_MODE === "provider503") return new Response(JSON.stringify({ error: { code: 503, message: "Synthetic provider outage", status: "UNAVAILABLE" } }), { status: 503 });
  return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify({
    serviceProvided: "Synthetic service", matchesCategory: true, hasBannedContent: false, confidenceScore: 95, reasoning: "Synthetic local moderation result",
  }) }] }, finishReason: "STOP" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
};
process.send({ type: "adapter-ready" });
await import("../../src/worker.js");
const { getMetrics } = await import("../../src/utils/metrics.js");
if (process.connected) await new Promise(resolve => process.send({ type: "final-metrics", metrics: getMetrics() }, resolve));
if (process.connected) process.disconnect();
