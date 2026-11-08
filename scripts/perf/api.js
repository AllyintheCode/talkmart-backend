import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { fork, execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose from "mongoose";
import { assertLocalDatabase, assertLocalOrigin, isolatedEnvironment, containsContact, summary, reportDirectory, machine, stopOwnedChild, sourceRevision } from "./common.js";

const { values } = parseArgs({ options: {
  videos: { type: "string", default: "1000,10000" }, requests: { type: "string", default: "100" },
  concurrency: { type: "string", default: "1,4" }, help: { type: "boolean", default: false },
} });
if (values.help) { console.log("node scripts/perf/api.js --videos=1000,10000 --requests=100 --concurrency=1,4\nOwned temporary local MongoDB and loopback API only; no external target option."); process.exit(0); }
const integers = (value, min, max) => {
  const parsed = value.split(",").map(item => Number(item));
  if (!parsed.length || parsed.some(number => !Number.isInteger(number) || number < min || number > max)) throw new Error("INVALID_BOUNDED_PERF_OPTIONS");
  return [...new Set(parsed)];
};
const sizes = integers(values.videos, 100, 100000), concurrencies = integers(values.concurrency, 1, 8);
const requests = integers(values.requests, 1, 200);
if (requests.length !== 1 || sizes.length > 3 || concurrencies.length > 3) throw new Error("PERF_MATRIX_TOO_LARGE");
const count = requests[0];
const directory = await reportDirectory("api");
const report = { kind: "local-api-baseline", machine: machine(), baselineCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  source: await sourceRevision(),
  startedAt: new Date().toISOString(), configuration: { sizes, requestsPerCase: count, concurrencies, warmupRequests: 5,
    loadModel: "bounded closed loop; not a production capacity estimate", redis: "disabled; real MongoDB rate-limit fallback",
    networking: "loopback; synthetic trusted-proxy client IP per case; rate limits unchanged", acceptEncoding: "identity plus separate gzip case" }, datasets: [] };
const objectId = (prefix, index) => new mongoose.Types.ObjectId(prefix + index.toString(16).padStart(16, "0"));
const userId = objectId("72000000", 1);
const providerIndex = index => (index * 7 + Math.floor(index / 20)) % 20;
const visible = (index, authed) => index % 11 >= 5 && providerIndex(index) >= 3 && (!authed || ![3, 4].includes(providerIndex(index)));
let replica, api, interrupted = false;
process.once("SIGINT", () => { interrupted = true; if (api?.connected) api.send({ type: "stop" }); });

async function seed(db, videoCount, runId) {
  await db.collection("_perf_runs").insertOne({ _id: runId, owned: true });
  const providers = Array.from({ length: 20 }, (_, index) => ({ _id: objectId("71000000", index), fullName: "Synthetic provider " + index,
    email: `provider${index}@example.invalid`, phone: `perf-provider-${index}`, role: "provider", password: "unused",
    emailVerified: index !== 2, isBlocked: index === 0, accountStatus: index === 1 ? "deleting" : "active", sessionVersion: 1,
    blockedUsers: index === 4 ? [userId] : [], providerProfile: { verified: true, companyName: "Synthetic service", address: "Synthetic private address" } }));
  await db.collection("users").insertMany([...providers, { _id: userId, fullName: "Synthetic reader", email: "reader@example.invalid", phone: "perf-reader",
    password: "unused", role: "user", emailVerified: true, isBlocked: false, accountStatus: "active", sessionVersion: 1, blockedUsers: [providers[3]._id] }]);
  await db.collection("categories").insertMany(Array.from({ length: 7 }, (_, index) => ({ _id: objectId("73000000", index), name: "Synthetic category " + index, status: "active" })));
  for (let offset = 0; offset < videoCount; offset += 1000) {
    if (interrupted) throw new Error("INTERRUPTED");
    const rows = Array.from({ length: Math.min(1000, videoCount - offset) }, (_, position) => {
      const index = offset + position, mode = index % 11;
      return { _id: objectId("74000000", index), providerId: providers[providerIndex(index)]._id, categoryId: objectId("73000000", index % 7),
        title: "Synthetic cleaning service " + index, description: "Synthetic performance fixture; no real media or personal data.", price: index % 200,
        videoUrl: `https://media.invalid/performance/${index}.mp4`, thumbnail: `https://media.invalid/performance/${index}.webp`,
        publicId: `talkmart/videos/performance/${index}.mp4`, processingStatus: mode === 2 ? "processing" : "ready",
        moderationStatus: mode === 0 ? "review" : mode === 1 ? "rejected" : mode === 2 ? "pending" : "approved",
        visibility: mode === 3 ? "hidden" : "public", status: mode <= 4 ? "inactive" : "active", schemaVersion: 2,
        likeCount: 0, saveCount: 0, viewCount: index % 1000, duration: 20,
        createdAt: new Date(Date.UTC(2026, 0, 1) + index * 1000), updatedAt: new Date(Date.UTC(2026, 0, 1) + index * 1000) };
    });
    await db.collection("videos").insertMany(rows);
  }
}

function request(origin, route, { headers = {}, method = "GET", agent } = {}) {
  const target = new URL(route, assertLocalOrigin(origin));
  if (target.origin !== origin) throw new Error("PERF_CROSS_ORIGIN_REQUEST");
  return new Promise(resolve => {
    const started = performance.now();
    const req = http.request(target, { method, agent, headers }, response => {
      const chunks = []; let bytes = 0;
      response.on("data", chunk => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) response.destroy(new Error("RESPONSE_TOO_LARGE")); else chunks.push(chunk); });
      response.on("error", error => resolve({ status: 0, error: error.message, elapsedMs: performance.now() - started }));
      response.on("end", () => {
        try {
          const wire = Buffer.concat(chunks), decoded = response.headers["content-encoding"] === "gzip" ? gunzipSync(wire) : wire;
          const body = JSON.parse(decoded.toString());
          resolve({ status: response.statusCode, body, wireBytes: bytes, decodedBytes: decoded.length, elapsedMs: performance.now() - started });
        } catch { resolve({ status: response.statusCode, error: "INVALID_JSON", elapsedMs: performance.now() - started }); }
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error("REQUEST_TIMEOUT")));
    req.on("error", error => resolve({ status: 0, error: error.code || error.message, elapsedMs: performance.now() - started }));
    req.end();
  });
}

function explainSummary(explanation) {
  const cursor = explanation.executionStats || explanation.stages?.find(stage => stage.$cursor)?.$cursor.executionStats;
  const stages = new Set(), indexes = new Set(), lookups = [];
  const walk = value => {
    if (!value || typeof value !== "object") return;
    if (typeof value.stage === "string") stages.add(value.stage);
    if (typeof value.indexName === "string") indexes.add(value.indexName);
    if (value.$lookup) lookups.push({ from: value.$lookup.from, docsExamined: value.totalDocsExamined, keysExamined: value.totalKeysExamined, indexesUsed: value.indexesUsed });
    for (const [key, item] of Object.entries(value)) if (!["rejectedPlans", "command", "serverInfo", "serverParameters"].includes(key)) walk(item);
  };
  walk(explanation);
  return { cursorDocsExamined: cursor?.totalDocsExamined, cursorKeysExamined: cursor?.totalKeysExamined,
    cursorReturned: cursor?.nReturned, queryStages: [...stages], indexes: [...indexes], lookups };
}

async function stopApi() {
  const processToStop = api; api = null;
  await stopOwnedChild(processToStop);
}

try {
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 }, binary: { downloadDir: path.resolve("node_modules/.cache/mongodb-memory-server") } });
  for (const size of sizes) {
    const runId = crypto.randomUUID().replaceAll("-", ""), uri = replica.getUri("talkmart_perf_" + runId);
    assertLocalDatabase(uri, runId);
    await mongoose.connect(uri, { autoCreate: false, autoIndex: false });
    const seedStarted = performance.now();
    await seed(mongoose.connection.db, size, runId);
    const dataset = { videos: size, users: 21, seedMs: performance.now() - seedStarted, cases: [] };
    report.datasets.push(dataset);
    console.log(`Local dataset: ${size} synthetic videos. Starting the real API in a separate process.`);
    const environment = isolatedEnvironment({ runId, uri, userId: String(userId), directory });
    const log = await fs.open(path.join(directory, `api-${size}.log`), "w", 0o600);
    const logStream = log.createWriteStream();
    api = fork(path.resolve("scripts/perf/api-server.js"), [], { env: environment, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    api.stdout.pipe(logStream, { end: false }); api.stderr.pipe(logStream, { end: false });
    api.once("close", () => logStream.end());
    const ready = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("PERF_API_START_TIMEOUT")), 30000);
      api.once("message", message => { clearTimeout(timeout); resolve(message); });
      api.once("error", error => { clearTimeout(timeout); reject(new Error("PERF_API_SPAWN_" + (error.code || error.name))); });
      api.once("exit", code => { clearTimeout(timeout); reject(new Error("PERF_API_EXIT_" + code)); });
    });
    if (ready.type !== "ready" || ready.runId !== runId) throw new Error("PERF_API_IDENTITY_MISMATCH");
    const origin = assertLocalOrigin(ready.origin), nonce = { "x-perf-run": runId };
    const scenarios = [
      { name: "guest_feed", route: "/api/videos/feed?limit=15" },
      { name: "authenticated_feed", route: "/api/videos/feed?limit=15", auth: true },
      { name: "explore_newest", route: "/api/videos/explore?limit=15&sort=newest" },
      { name: "guest_feed_gzip", route: "/api/videos/feed?limit=15", gzip: true },
    ];
    let caseIndex = 0;
    for (const scenario of scenarios) for (const concurrency of concurrencies) {
      if (interrupted) throw new Error("INTERRUPTED");
      const name = `${scenario.name}_c${concurrency}`;
      const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency });
      try {
        const headers = { ...nonce, "x-perf-case": name, "x-forwarded-for": `198.18.0.${++caseIndex}`, "accept-encoding": scenario.gzip ? "gzip" : "identity" };
        if (scenario.auth) headers.authorization = "Bearer " + ready.token;
        for (let warmup = 0; warmup < 5; warmup++) await request(origin, scenario.route, { headers, agent });
        await request(origin, "/_perf/reset", { headers: nonce, method: "POST" });
        const samples = [], errors = [], statuses = {};
        let issued = 0;
        const start = performance.now();
        await Promise.all(Array.from({ length: concurrency }, async () => {
          while (issued++ < count && !interrupted) {
            const response = await request(origin, scenario.route, { headers, agent });
            statuses[response.status] = (statuses[response.status] || 0) + 1;
            const videos = response.body?.videos;
            let error = response.error;
            if (response.status !== 200) error ||= "HTTP_" + response.status;
            if (!response.body?.success || !Array.isArray(videos) || !videos.length || videos.length > 15) error ||= "INVALID_VIDEO_CONTRACT";
            if (containsContact(response.body)) error = "CONTACT_LEAK";
            if (Array.isArray(videos)) for (const video of videos) {
              const index = parseInt(String(video._id).slice(8), 16);
              if (!/^74000000[0-9a-f]{16}$/.test(String(video._id)) || index >= size || !visible(index, scenario.auth)) error = "INELIGIBLE_VIDEO_EXPOSED";
            }
            if (error) errors.push(error);
            else samples.push({ ms: response.elapsedMs, bytes: response.wireBytes, decoded: response.decodedBytes, returned: videos.length });
          }
        }));
        const elapsedMs = performance.now() - start;
        const metrics = await request(origin, "/_perf/stats", { headers: nonce });
        const explanation = await request(origin, "/_perf/explain?case=" + name, { headers: nonce });
        if (metrics.status !== 200 || explanation.status !== 200) throw new Error("PERF_METRICS_OR_EXPLAIN_FAILED");
        await fs.writeFile(path.join(directory, `explain-${size}-${name}.json`), JSON.stringify(explanation.body, null, 2), { mode: 0o600 });
        let countExplanation;
        if (metrics.body.countPipelineCases?.includes(name)) {
          const counted = await request(origin, "/_perf/explain?case=" + name + "&phase=provider-counts", { headers: nonce });
          if (counted.status !== 200) throw new Error("PERF_COUNT_EXPLAIN_FAILED");
          await fs.writeFile(path.join(directory, `explain-${size}-${name}-provider-counts.json`), JSON.stringify(counted.body, null, 2), { mode: 0o600 });
          countExplanation = explainSummary(counted.body);
        }
        const latency = summary(samples.map(sample => sample.ms));
        const result = { name, concurrency, attempted: Object.values(statuses).reduce((a, b) => a + b, 0), statuses, errors: [...new Set(errors)], errorCount: errors.length,
          rateLimited: statuses[429] || 0, elapsedMs, observedRequestsPerSecond: Object.values(statuses).reduce((a, b) => a + b, 0) / elapsedMs * 1000,
          successfulLatencyMs: latency, wireBytes: summary(samples.map(sample => sample.bytes)), decodedBytes: summary(samples.map(sample => sample.decoded)),
          returnedVideos: summary(samples.map(sample => sample.returned)), slo: { targetP95Ms: 500, met: latency.samples === count && errors.length === 0 && latency.p95 < 500 },
          api: metrics.body, explain: { ...explainSummary(explanation.body), ...(countExplanation ? { providerCounts: countExplanation } : {}) } };
        dataset.cases.push(result);
        console.log(`${size} ${name}: p95=${latency.p95?.toFixed(1) ?? "n/a"} ms, errors=${errors.length}, 429=${result.rateLimited}`);
      } finally { agent.destroy(); }
    }
    await stopApi();
    await mongoose.disconnect();
  }
} catch (error) {
  report.failure = error.code || error.message;
  process.exitCode = 1;
} finally {
  await stopApi(); await mongoose.disconnect(); if (replica) await replica.stop();
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(directory, "api-report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  const lines = ["# Local API baseline", "", "Loopback, synthetic fixtures, one local replica-set member, Redis disabled. Closed-loop microbenchmark; not a VPS capacity estimate.", "",
    "| Videos | Scenario | Samples | p95 ms | Errors | 429 | Wire bytes mean | Cursor docs examined |", "|---:|---|---:|---:|---:|---:|---:|---:|"];
  for (const dataset of report.datasets) for (const item of dataset.cases) lines.push(`| ${dataset.videos} | ${item.name} | ${item.successfulLatencyMs.samples} | ${item.successfulLatencyMs.p95?.toFixed(1) ?? "n/a"} | ${item.errorCount} | ${item.rateLimited} | ${item.wireBytes.mean?.toFixed(0) ?? "n/a"} | ${item.explain.cursorDocsExamined ?? "n/a"} |`);
  if (report.failure) lines.push("", "Run failed: " + report.failure);
  lines.push("", "API RSS/CPU excludes MongoDB, the generator and FFmpeg. Read api-report.json and the exact captured-pipeline explain files for detail.");
  await fs.writeFile(path.join(directory, "api-report.md"), lines.join("\n") + "\n");
  if (report.datasets.some(dataset => dataset.cases.some(item => item.errorCount))) process.exitCode = 1;
  console.log("Report:", path.join(directory, "api-report.md"));
  if (report.failure) console.error("Benchmark stopped:", report.failure);
}
