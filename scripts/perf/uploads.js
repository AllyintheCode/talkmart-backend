import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { fork, execFile } from "node:child_process";
import { promisify, parseArgs } from "node:util";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import FormData from "form-data";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import ffmpeg from "ffmpeg-static";
import { uploadMatrix } from "./upload-options.js";
import { uploadObjectName } from "./upload-storage.js";
import { assertLocalDatabase, assertLocalOrigin, isolatedEnvironment, reportDirectory, sourceRevision, machine, summary, stopOwnedChild } from "./common.js";

const { values } = parseArgs({ options: { sizes: { type: "string", default: "20,35,50" }, concurrency: { type: "string", default: "5,10,25" }, help: { type: "boolean", default: false } } });
if (values.help) { console.log("node scripts/perf/uploads.js [--sizes=20,35,50] [--concurrency=5,10,25]\nReal multipart HTTP/API/MongoDB intake, owned loopback only. Disk-backed S3 multipart stub; no worker, Gemini or external R2."); process.exit(0); }
const matrix = uploadMatrix(values.sizes, values.concurrency);
const directory = await reportDirectory("uploads"), runId = crypto.randomUUID().replaceAll("-", "");
const harnessDigest = crypto.createHash("sha256");
for (const file of ["upload-options.js", "upload-storage.js", "upload-server.js", "uploads.js"]) { harnessDigest.update(file + "\0"); harnessDigest.update(await fs.readFile(path.join("scripts/perf", file))); }
const report = { kind: "local-parallel-upload-intake", startedAt: new Date().toISOString(), source: await sourceRevision(), machine: machine(), matrix,
  harnessSourceSha256: harnessDigest.digest("hex"),
  notes: ["Real HTTP multipart body, auth, production quota/rate-limit middleware, Multer disk streaming, FFprobe, AWS Upload multipart assembly and durable MongoDB queue.",
    "S3 send is replaced with an owned disk adapter. Gemini, Redis, SMTP and worker processing are absent.",
    "20/35/50 decimal MB files contain the same short synthetic H.264/AAC video plus an MP4 free box. This isolates ingestion bytes, not 4K decode workload.",
    "One fresh provider per simultaneous upload. Rate limits are unchanged; same-provider concurrency is tested separately.",
    "Timing includes the entire loopback file upload, not a direct-upload-init endpoint. Few samples are not a production p95 or capacity guarantee.",
    "API RSS is sampled every 50 ms and excludes the generator, MongoDB, FFprobe and the OS file cache."], cases: [] };
let replica, api, environment, ready, db, interrupted = false;
const timeout = setTimeout(() => { interrupted = true; api?.kill("SIGKILL"); }, 180000);
process.once("SIGINT", () => { interrupted = true; api?.kill("SIGKILL"); });
const hash = async filename => { const digest = crypto.createHash("sha256"); for await (const chunk of createReadStream(filename)) digest.update(chunk); return digest.digest("hex"); };
const providers = Array.from({ length: 25 }, () => new mongoose.Types.ObjectId()), category = new mongoose.Types.ObjectId();
async function until(check, label) {
  const end = Date.now() + 10000;
  while (!interrupted && Date.now() < end) { if (await check()) return; await delay(50); }
  throw new Error("UPLOAD_WAIT_EXPIRED_" + label);
}
function responseBody(response, started, cleanup, resolve) {
  const chunks = []; let bytes = 0;
  response.on("data", chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) response.destroy(new Error("PERF_RESPONSE_TOO_LARGE")); else chunks.push(chunk); });
  response.on("error", error => { cleanup(); resolve({ status: 0, error: error.code || error.message, elapsedMs: performance.now() - started }); });
  response.on("end", () => {
    cleanup();
    try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks)), elapsedMs: performance.now() - started }); }
    catch { resolve({ status: response.statusCode, error: "INVALID_JSON", elapsedMs: performance.now() - started }); }
  });
}
function request(route, { index = 0, method = "GET", uploadId, fixture } = {}) {
  const origin = assertLocalOrigin(ready.origin), target = new URL(route, origin);
  if (target.origin !== origin) throw new Error("PERF_UPLOAD_CROSS_ORIGIN");
  return new Promise(resolve => {
    const started = performance.now(); let form, stream;
    const headers = { authorization: "Bearer " + ready.tokens[index], "x-perf-run": runId };
    if (uploadId) headers["Idempotency-Key"] = uploadId;
    if (fixture) {
      form = new FormData();
      form.append("title", "Synthetic upload intake"); form.append("description", "Synthetic local performance fixture");
      form.append("price", "1"); form.append("categoryId", String(category));
      stream = createReadStream(fixture.file);
      form.append("video", stream, { filename: "fixture.mp4", contentType: "video/mp4", knownLength: fixture.bytes });
      Object.assign(headers, form.getHeaders(), { "content-length": form.getLengthSync() });
    }
    const cleanup = () => { stream?.destroy(); form?.destroy(); };
    const req = http.request(target, { method, headers, agent: false }, response => responseBody(response, started, cleanup, resolve));
    req.setTimeout(60000, () => req.destroy(new Error("PERF_UPLOAD_HTTP_TIMEOUT")));
    req.on("error", error => { cleanup(); resolve({ status: 0, error: error.code || error.message, elapsedMs: performance.now() - started }); });
    if (form) { form.on("error", error => req.destroy(error)); form.pipe(req); }
    else req.end();
  });
}
async function startApi() {
  api = fork(path.resolve("scripts/perf/upload-server.js"), [], { env: environment, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const log = createWriteStream(path.join(directory, "api.log"), { flags: "a", mode: 0o600 });
  api.stdout.pipe(log, { end: false }); api.stderr.pipe(log, { end: false }); api.once("close", () => log.end());
  ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("PERF_UPLOAD_API_START_TIMEOUT")), 30000);
    api.once("message", message => { clearTimeout(timer); resolve(message); });
    api.once("exit", () => { clearTimeout(timer); reject(new Error("PERF_UPLOAD_API_EARLY_EXIT")); });
    api.once("error", error => { clearTimeout(timer); reject(error); });
  });
  assert.equal(ready.type, "ready"); assert.equal(ready.runId, runId); assert.equal(ready.tokens.length, 25); assertLocalOrigin(ready.origin);
}
async function settle() {
  await until(async () => await db.collection("users").countDocuments({ uploadReservation: { $type: "string", $ne: "" } }) === 0, "RESERVATIONS");
  await until(async () => (await fs.readdir(path.join(directory, "api-temp"))).length === 0, "TEMP_FILES");
}
async function verify(rows, fixture) {
  assert.equal(new Set(rows.map(row => String(row._id))).size, rows.length);
  for (const row of rows) {
    assert.equal(row.processingStatus, "queued"); assert.equal(row.moderationStatus, "pending"); assert.equal(row.status, "inactive");
    assert.equal(row.sourceBytes, fixture.bytes); assert.equal(row.publicId, "");
    const filename = path.join(directory, "objects", uploadObjectName("perf-private", row.stagingKey));
    assert.equal(await hash(filename), fixture.sha256);
  }
  assert.equal((await fs.readdir(path.join(directory, "parts"))).length, 0);
  assert.equal((await fs.readdir(path.join(directory, "objects"))).length, rows.length);
  await settle();
}
async function clearCase() {
  await settle();
  assertLocalDatabase(environment.MONGO_URI, runId);
  await db.collection("videos").deleteMany({});
  const objects = await fs.realpath(path.join(directory, "objects"));
  assert.equal(path.dirname(objects), directory);
  for (const name of await fs.readdir(objects)) { assert.match(name, /^[a-f0-9]{64}$/); await fs.rm(path.join(objects, name)); }
}
try {
  await fs.writeFile(path.join(directory, "upload-owner.json"), JSON.stringify({ kind: "local-upload-intake", runId }));
  await fs.mkdir(path.join(directory, "api-temp"));
  const source = path.join(directory, "small-source.mp4");
  await promisify(execFile)(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=25:duration=1",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-threads", "2", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", "-shortest", "-n", source],
  { timeout: 30000, windowsHide: true });
  const sourceBytes = (await fs.stat(source)).size, fixtures = [];
  for (const mb of matrix.sizes) {
    const file = path.join(directory, `fixture-${mb}MB.mp4`), bytes = mb * 1000 * 1000;
    await fs.copyFile(source, file);
    const handle = await fs.open(file, "r+");
    try { const box = Buffer.alloc(8); box.writeUInt32BE(bytes - sourceBytes); box.write("free", 4); await handle.write(box, 0, 8, sourceBytes); await handle.truncate(bytes); }
    finally { await handle.close(); }
    fixtures.push({ mb, file, bytes, sha256: await hash(file) });
  }
  report.fixtures = fixtures.map(({ file, ...rest }) => ({ file: path.basename(file), ...rest }));
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 }, binary: { downloadDir: path.resolve("node_modules/.cache/mongodb-memory-server") } });
  const uri = replica.getUri("talkmart_perf_" + runId); assertLocalDatabase(uri, runId);
  await mongoose.connect(uri); db = mongoose.connection.db;
  await db.collection("_perf_runs").insertOne({ _id: runId, owned: true, providers });
  await db.collection("users").insertMany(providers.map((id, index) => ({ _id: id, fullName: "Synthetic provider " + index,
    email: `upload-${index}@example.invalid`, phone: `local-upload-${index}`, password: "unused", role: "provider", emailVerified: true,
    providerProfile: { verified: true }, accountStatus: "active", isBlocked: false, sessionVersion: 1, blockedUsers: [] })));
  await db.collection("categories").insertOne({ _id: category, name: "Synthetic service", status: "active" });
  environment = { ...isolatedEnvironment({ runId, uri, directory }), PERF_REPORT_DIRECTORY: directory,
    TMP: path.join(directory, "api-temp"), TEMP: path.join(directory, "api-temp"), TMPDIR: path.join(directory, "api-temp") };
  await startApi();
  let caseIndex = 0;
  for (const fixture of fixtures) for (const concurrency of matrix.concurrencies) {
    if (interrupted) throw new Error("PERF_UPLOAD_INTERRUPTED");
    const name = `${fixture.mb}MB_c${concurrency}`, uploadId = index => `local-${runId}-${caseIndex}-${index}`;
    const item = { name, payloadBytes: fixture.bytes, concurrency }; report.cases.push(item);
    assert.equal((await request("/_perf/reset", { method: "POST" })).status, 200);
    const started = performance.now();
    const responses = await Promise.all(Array.from({ length: concurrency }, (_, index) => request("/api/videos/upload", { index, method: "POST", uploadId: uploadId(index), fixture })));
    item.batchElapsedMs = performance.now() - started;
    item.statuses = responses.reduce((all, response) => { all[response.status] = (all[response.status] || 0) + 1; return all; }, {});
    item.errors = responses.filter(response => response.status !== 201 || !response.body?.success).map(response => ({ status: response.status, code: response.error || response.body?.error?.code || "INVALID_UPLOAD_RESPONSE" }));
    item.fullHttpUploadMs = summary(responses.filter(response => response.status === 201).map(response => response.elapsedMs));
    item.api = (await request("/_perf/stats")).body;
    assert.equal(item.errors.length, 0, JSON.stringify(item.errors));
    const rows = await db.collection("videos").find({}).toArray(); assert.equal(rows.length, concurrency);
    await verify(rows, fixture);
    assert.equal(item.api.storage.inFlight, 0); assert.equal(item.api.storage.completed, concurrency);
    assert.equal(item.api.storage.partsUploaded, Math.ceil(fixture.bytes / (8 * 1024 * 1024)) * concurrency);
    item.persistedPrivateOriginalsByteIdentical = true; item.noTempOrMultipartLeaks = true;
    if (caseIndex === 0) {
      const replay = await request("/api/videos/upload", { method: "POST", uploadId: uploadId(0) });
      assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true);
      assert.equal(String(replay.body.video._id), String(responses[0].body.video._id));
      assert.equal(await db.collection("videos").countDocuments(), concurrency);
      item.idempotentReplayWithoutResendingFile = true;
      await stopOwnedChild(api); api = undefined; await startApi();
      const mine = await request("/api/videos/my-videos"); assert.equal(mine.status, 200);
      assert.equal(mine.body.videos[0]._id, responses[0].body.video._id);
      await verify(await db.collection("videos").find({}).toArray(), fixture);
      item.queueAndOriginalsSurviveApiRestart = true;
    }
    item.ok = true;
    console.log(`${name}: ${concurrency}/${concurrency} accepted, full HTTP p95=${item.fullHttpUploadMs.p95.toFixed(0)} ms, API peak RSS=${Math.round(item.api.apiPeakRssBytes / 1024 ** 2)} MiB`);
    await clearCase(); caseIndex++;
  }
  const fixture = fixtures[0];
  const race = await Promise.all(Array.from({ length: 5 }, (_, index) => request("/api/videos/upload", { index: 24, method: "POST", uploadId: `race-${runId}-${index}`, fixture })));
  assert.equal(race.filter(response => response.status === 201).length, 1);
  assert.equal(race.filter(response => response.status === 429 && response.body?.error?.code === "UPLOAD_CONCURRENCY").length, 4);
  const rows = await db.collection("videos").find({}).toArray(); assert.equal(rows.length, 1); await verify(rows, fixture);
  report.sameProviderConcurrency = { attempted: 5, accepted: 1, expectedConcurrency429: 4, noDuplicateJobs: true, noTempLeaks: true };
  console.log("Same provider: 1 accepted, 4 expected UPLOAD_CONCURRENCY, no duplicate jobs or leaked files");
  await clearCase();
} catch (error) { report.failure = error.code || error.message || error.name; process.exitCode = 1; }
finally {
  clearTimeout(timeout); await stopOwnedChild(api); await mongoose.disconnect(); if (replica) await replica.stop();
  const temporary = path.join(directory, "api-temp");
  if (await fs.realpath(directory) !== directory || path.dirname(temporary) !== directory || path.dirname(directory) !== await fs.realpath("tmp/performance")) throw new Error("PERF_UPLOAD_CLEANUP_NOT_OWNED");
  await fs.rm(temporary, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(directory, "upload-report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  const lines = ["# Local parallel HTTP upload intake", "", ...report.notes, "", "| Payload | Concurrent providers | Accepted | Full HTTP p95 ms | API peak RSS MiB | Passed |", "|---|---:|---:|---:|---:|---|",
    ...report.cases.map(item => `| ${item.payloadBytes} | ${item.concurrency} | ${item.statuses?.[201] || 0} | ${item.fullHttpUploadMs?.p95?.toFixed(0) || "n/a"} | ${item.api?.apiPeakRssBytes ? Math.round(item.api.apiPeakRssBytes / 1024 ** 2) : "n/a"} | ${item.ok ? "yes" : "no"} |`)];
  if (report.failure) lines.push("", "Failure: " + report.failure);
  await fs.writeFile(path.join(directory, "upload-report.md"), lines.join("\n") + "\n");
  console.log("Report:", path.join(directory, "upload-report.md"));
  if (report.failure) console.error("Upload intake check failed:", report.failure);
}
