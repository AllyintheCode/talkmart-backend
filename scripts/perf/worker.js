import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { fork, execFile } from "node:child_process";
import { once } from "node:events";
import { promisify, parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import ffmpeg from "ffmpeg-static";
import Video from "../../src/models/Video.js";
import User from "../../src/models/User.js";
import Category from "../../src/models/Category.js";
import WorkerStatus from "../../src/models/WorkerStatus.js";
import { isolatedEnvironment, assertLocalDatabase, reportDirectory, machine, sourceRevision, stopOwnedChild, summary } from "./common.js";

const { values } = parseArgs({ options: { help: { type: "boolean", default: false } } });
if (values.help) { console.log("node scripts/perf/worker.js\nOwned local MongoDB and actual worker subprocess; local IPC storage and model stubs. No external target or .env."); process.exit(0); }
const runId = crypto.randomUUID().replaceAll("-", ""), directory = await reportDirectory("worker");
const report = { kind: "local-worker-recovery", machine: machine(), source: await sourceRevision(), startedAt: new Date().toISOString(),
  notes: ["Actual worker.js and FFmpeg with one owned local replica-set member.", "R2 operations use an IPC in-memory adapter; Gemini SDK uses a synthetic 250 ms response or HTTP 503.",
    "Crash means SIGKILL of the owned worker process. Leases are explicitly expired in the owned database; five minutes of real time are not waited.",
    "Batches are already queued jobs, not HTTP uploads or a production throughput estimate."], cases: [] };
const objects = new Map(), operations = [];
let replica, child, storageHook, env, provider, category, inputBytes, interrupted = false;
const logs = [];
const deadline = setTimeout(() => { interrupted = true; child?.kill("SIGKILL"); }, 240000);
process.once("SIGINT", () => { interrupted = true; child?.kill("SIGKILL"); });
async function until(check, label, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end && !interrupted) {
    const result = await check(); if (result) return result;
    if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error("WORKER_EXITED_" + label);
    await delay(80);
  }
  throw new Error("WAIT_EXPIRED_" + label);
}
async function storage(message, owner) {
  const { Bucket, Key, bodyBase64, CopySource, Prefix } = message.input;
  assert.ok(["perf-media", "perf-private"].includes(Bucket), "UNEXPECTED_BUCKET");
  const objectId = `${Bucket}:${Key}`;
  operations.push({ at: Date.now(), command: message.command, bucket: Bucket, key: Key });
  let result = {};
  switch (message.command) {
    case "GetObjectCommand": {
      const bytes = objects.get(objectId); if (!bytes) throw Object.assign(new Error(), { code: "NoSuchKey" });
      result = { bodyBase64: bytes.toString("base64") }; break;
    }
    case "PutObjectCommand": objects.set(objectId, Buffer.from(bodyBase64, "base64")); result = { ETag: "local-test", $metadata: { httpStatusCode: 200 } }; break;
    case "DeleteObjectCommand": objects.delete(objectId); break;
    case "CopyObjectCommand": {
      const source = decodeURIComponent(CopySource).replace(/^\/+/, ""), slash = source.indexOf("/");
      const bytes = objects.get(source.slice(0, slash) + ":" + source.slice(slash + 1));
      if (!bytes) throw Object.assign(new Error(), { code: "NoSuchKey" });
      objects.set(objectId, Buffer.from(bytes)); result = { CopyObjectResult: { ETag: "local-test" } }; break;
    }
    case "ListObjectsV2Command": result = { Contents: [...objects.keys()].filter(key => key.startsWith(`${Bucket}:${Prefix}`)).slice(0, 100)
      .map(key => ({ Key: key.slice(Bucket.length + 1), LastModified: new Date() })) }; break;
    default: throw new Error("UNEXPECTED_STORAGE_COMMAND_" + message.command);
  }
  if (storageHook && await storageHook(message)) return; // Simulate a process dying before its storage response.
  if (owner.connected) owner.send({ type: "storage-result", id: message.id, result }, () => {});
}
async function start(mode = "approved") {
  assert.equal(child, undefined);
  const worker = child = fork(path.resolve("scripts/perf/worker-child.js"), [], { cwd: process.cwd(), env: { ...env, PERF_AI_MODE: mode }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  for (const stream of [worker.stdout, worker.stderr]) stream.on("data", chunk => { logs.push(chunk.toString()); if (logs.length > 300) logs.shift(); });
  worker.on("message", message => {
    if (message?.type === "final-metrics") { worker.finalMetrics = message.metrics; return; }
    if (message?.type !== "storage") return;
    storage(message, worker).catch(error => { if (worker.connected) worker.send({ type: "storage-result", id: message.id, error: { code: error.code || error.message || error.name } }, () => {}); });
  });
  await until(() => WorkerStatus.exists({ _id: { $regex: `^${worker.pid}-` } }), "WORKER_HEARTBEAT", 20000);
  return worker;
}
async function stop(kill = false) {
  if (!child) return;
  const worker = child;
  if (kill && worker.exitCode === null && worker.signalCode === null) {
    const exited = once(worker, "exit"); worker.kill("SIGKILL"); await exited;
  } else await stopOwnedChild(worker);
  child = undefined;
  return worker.finalMetrics || {};
}
async function queued(count) {
  const videos = [];
  for (let index = 0; index < count; index++) {
    const id = new mongoose.Types.ObjectId(), key = `talkmart/staging/${provider._id}/${id}.mp4`;
    objects.set(`perf-private:${key}`, inputBytes);
    videos.push({ _id: id, providerId: provider._id, categoryId: category._id, categoryName: category.name,
      description: "Synthetic worker fixture", price: 1, duration: 1, sourceBytes: inputBytes.length, originalExt: ".mp4", stagingKey: key,
      status: "inactive", processingStatus: "queued", moderationStatus: "pending", schemaVersion: 2 });
  }
  return Video.create(videos);
}
async function reset() {
  assert.equal(child, undefined); storageHook = undefined;
  await Video.deleteMany({}); await WorkerStatus.deleteMany({}); objects.clear(); operations.length = 0;
}
async function record(name, work) {
  const started = performance.now();
  const item = { name }; report.cases.push(item);
  await work(item); item.elapsedMs = performance.now() - started; item.ok = true;
  console.log(name + ": OK (" + Math.round(item.elapsedMs) + " ms)");
}
try {
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 }, binary: { downloadDir: path.resolve("node_modules/.cache/mongodb-memory-server") } });
  const uri = replica.getUri("talkmart_perf_" + runId); assertLocalDatabase(uri, runId);
  const temporary = path.join(directory, "worker-temp");
  await fs.mkdir(temporary);
  env = { ...isolatedEnvironment({ runId, uri, directory }), PERF_REPORT_DIRECTORY: directory,
    TMP: temporary, TEMP: temporary, TMPDIR: temporary };
  await mongoose.connect(uri);
  await mongoose.connection.db.collection("_perf_runs").insertOne({ _id: runId, owned: true });
  await Promise.all([Video, User, Category, WorkerStatus].map(model => model.init()));
  provider = await User.create({ fullName: "Synthetic provider", email: "worker@example.invalid", phone: "local-worker", password: "unused", role: "provider", emailVerified: true, providerProfile: { verified: true } });
  category = await Category.create({ name: "Synthetic service" });
  const input = path.join(directory, "input.mp4");
  await promisify(execFile)(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=25:duration=1",
    "-filter_threads", "1", "-c:v", "libx264", "-threads", "2", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-y", input], { timeout: 30000, windowsHide: true, env });
  inputBytes = await fs.readFile(input);

  await record("crash_during_download_recovers_same_job", async item => {
    const [video] = await queued(1); let held = false;
    storageHook = message => { if (message.command === "GetObjectCommand") { held = true; return true; } return false; };
    await start(); await until(() => held, "DOWNLOAD_HELD");
    const leased = await Video.findById(video._id); assert.equal(leased.attempt, 1); assert.equal(leased.processingStatus, "processing");
    await stop(true); storageHook = undefined;
    await start();
    const fenced = await Video.findById(video._id); assert.equal(fenced.attempt, 1); assert.equal(fenced.workerId, leased.workerId);
    await Video.updateOne({ _id: video._id, workerId: leased.workerId }, { $set: { lockedUntil: new Date(0) } });
    const finished = await until(async () => { const current = await Video.findById(video._id); return current.status === "active" && !current.stagingKey && current; }, "DOWNLOAD_RECOVERED");
    assert.equal(finished.attempt, 2); assert.equal(await Video.countDocuments(), 1);
    assert.equal(finished.moderationStatus, "approved"); assert.ok(objects.has(`perf-media:${finished.publicId}`));
    item.attempts = finished.attempt; item.activeLeaseWasRespected = true; item.jobIdPreserved = true;
    await stop();
  });
  await reset();
  await record("crash_after_private_commit_reconciles_publication", async item => {
    const [video] = await queued(1); let copied;
    storageHook = message => { if (message.command === "CopyObjectCommand" && message.input.Bucket === "perf-media") { copied = message.input.Key; return true; } return false; };
    await start(); await until(() => copied, "PUBLIC_COPY_HELD");
    const committed = await Video.findById(video._id); assert.equal(committed.processingStatus, "ready"); assert.equal(committed.status, "inactive"); assert.ok(committed.privateVideoKey);
    await stop(true); storageHook = undefined;
    await start(); assert.equal((await Video.findById(video._id)).status, "inactive"); await stop();
    await Video.updateOne({ _id: video._id }, { $set: { mediaPublicationUntil: new Date(0) } });
    await start();
    const finished = await until(async () => { const current = await Video.findById(video._id); return current.status === "active" && !current.stagingKey && current; }, "PUBLICATION_RECOVERED");
    assert.equal(finished.attempt, 1); assert.equal(await Video.countDocuments(), 1);
    assert.notEqual(finished.publicId, copied); assert.equal(objects.has(`perf-media:${copied}`), false);
    assert.ok(objects.has(`perf-private:${finished.privateVideoKey}`));
    assert.equal([...objects.keys()].filter(key => key.startsWith("perf-media:")).length, 2);
    item.jobIdPreserved = true; item.activeMediaLeaseWasRespected = true; item.partialCopyRemoved = true;
    await stop();
  });
  await reset();
  await record("provider_503_keeps_ready_media_private_for_review", async item => {
    const [video] = await queued(1); await start("provider503");
    const finished = await until(async () => { const current = await Video.findById(video._id); return current.processingStatus === "ready" && !current.stagingKey && current; }, "OUTAGE_REVIEW");
    assert.equal(finished.moderationStatus, "review"); assert.equal(finished.status, "inactive"); assert.equal(finished.videoUrl, "");
    assert.ok(objects.has(`perf-private:${finished.privateVideoKey}`)); assert.equal([...objects.keys()].some(key => key.startsWith("perf-media:")), false);
    item.feedback = finished.aiFeedback; item.publicObjects = 0; await stop();
  });
  for (const count of [5, 10, 25]) {
    await reset();
    await record("queued_batch_" + count, async item => {
      await queued(count); await start();
      await until(async () => await Video.countDocuments({ status: "active", processingStatus: "ready", moderationStatus: "approved", stagingKey: "" }) === count, "BATCH_" + count, 90000);
      const videos = await Video.find().lean();
      assert.equal(videos.length, count); assert.ok(videos.every(video => video.attempt === 1));
      assert.equal(new Set(videos.map(video => video.publicId)).size, count);
      assert.equal([...objects.keys()].filter(key => key.startsWith("perf-media:")).length, count * 2);
      assert.equal([...objects.keys()].some(key => key.includes(":talkmart/staging/")), false);
      item.jobs = count; item.lost = 0; item.duplicatePublications = 0;
      item.completedFromCreatedMs = summary(videos.map(video => new Date(video.completedAt) - new Date(video.createdAt)));
      item.workerMetrics = await stop();
    });
  }
} catch (error) { report.failure = error.code || error.message || error.name; process.exitCode = 1; }
finally {
  clearTimeout(deadline); await stop(); await mongoose.disconnect(); if (replica) await replica.stop();
  const temporary = path.resolve(directory, "worker-temp");
  if (path.dirname(temporary) !== path.resolve(directory)) throw new Error("PERF_TEMP_DELETE_OUTSIDE_REPORT");
  await fs.rm(temporary, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(directory, "worker-report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  await fs.writeFile(path.join(directory, "worker.log"), logs.join(""), { mode: 0o600 });
  const lines = ["# Local worker recovery", "", ...report.notes, "", "| Case | Passed | Elapsed ms |", "|---|---|---:|",
    ...report.cases.map(item => `| ${item.name} | ${item.ok ? "yes" : "no"} | ${item.elapsedMs?.toFixed(0) || "n/a"} |`)];
  if (report.failure) lines.push("", "Failure: " + report.failure);
  await fs.writeFile(path.join(directory, "worker-report.md"), lines.join("\n") + "\n");
  console.log("Report:", path.join(directory, "worker-report.md"));
  if (report.failure) console.error("Worker check failed:", report.failure);
}
