import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import mongoose from "mongoose";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { openStaging, releaseDirectory } from "./safety.js";

const { values } = parseArgs({ options: { id: { type: "string" }, wait: { type: "boolean", default: false }, help: { type: "boolean", default: false } } });
if (values.help) { console.log("node scripts/staging/check-upload.js --id=<24-hex-video-id> [--wait]\nRead-only staging video, R2 object sizes and current test-worker metrics. Never prints credentials, media keys or signed URLs."); process.exit(0); }
if (!/^[a-f\d]{24}$/i.test(values.id || "")) throw new Error("VIDEO_ID_REQUIRED");
let r2;
try {
  await openStaging();
  const db = mongoose.connection.db, id = new mongoose.Types.ObjectId(values.id);
  const video = () => db.collection("videos").findOne({ _id: id, providerId: new mongoose.Types.ObjectId("6adfd4c4eefbfb98a5fbfa2e"), status: { $ne: "deleting" } });
  const finished = v => v.processingStatus === "failed" || (v.processingStatus === "ready" && v.moderationStatus !== "pending" && (v.status === "active" || v.moderationStatus !== "approved"));
  let v, previous;
  const end = Date.now() + (values.wait ? 240000 : 0);
  do {
    v = await video();
    if (!v) throw new Error("TEST_VIDEO_NOT_FOUND");
    const state = [v.processingStatus, v.moderationStatus, v.status, v.attempt].join(" / ");
    if (previous !== state) { console.log("Video:", state); previous = state; }
    if (finished(v) || !values.wait) break;
    await delay(2000);
  } while (Date.now() < end);

  const workerProcess = JSON.parse(execFileSync("pm2", ["jlist"], { encoding: "utf8", timeout: 10000 }))
    .find(item => item.name === "talkmart-worker-test");
  if (workerProcess?.pm2_env?.pm_cwd !== releaseDirectory || workerProcess.pm2_env.status !== "online") throw new Error("TEST_WORKER_STATE_MISMATCH");
  const workerStatus = () => db.collection("workerstatuses").findOne({ _id: new RegExp("^" + workerProcess.pid + "-") }, { sort: { heartbeatAt: -1 } });
  let worker = await workerStatus();
  if (values.wait && v.completedAt) {
    const metricDeadline = Date.now() + 45000;
    while ((!worker || new Date(worker.heartbeatAt) < new Date(v.completedAt) || worker.running !== 0) && Date.now() < metricDeadline) {
      console.log("Worker metriklərinin yenilənməsi gözlənilir...");
      await delay(3000); worker = await workerStatus();
    }
  }
  r2 = (await import("../../src/config/r2.js")).default;
  const { bucketFor } = await import("../../src/services/r2Upload.service.js");
  async function objectInfo(key) {
    if (!key) return null;
    const response = await r2.send(new HeadObjectCommand({ Bucket: bucketFor(key), Key: key }), { abortSignal: AbortSignal.timeout(15000) });
    return { bytes: response.ContentLength, contentType: response.ContentType };
  }
  const report = {
    observedAt: new Date().toISOString(), repoCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    video: { id: String(v._id), title: v.title, processingStatus: v.processingStatus, moderationStatus: v.moderationStatus, status: v.status,
      moderationSource: v.moderationSource, aiConfidence: v.aiConfidence, aiFeedback: v.aiFeedback, attempt: v.attempt,
      sourceBytes: v.sourceBytes, duration: v.duration, createdAt: v.createdAt, completedAt: v.completedAt,
      createdToMediaCommitSeconds: v.completedAt ? (new Date(v.completedAt) - new Date(v.createdAt)) / 1000 : null,
      hasPrivateMedia: Boolean(v.privateVideoKey), hasPublicMedia: Boolean(v.publicId), mediaRevocationPending: Boolean(v.mediaRevocationPending),
      privateObject: await objectInfo(v.privateVideoKey), publicObject: await objectInfo(v.publicId) },
    worker: { pid: workerProcess.pid, startedAt: new Date(workerProcess.pm2_env.pm_uptime).toISOString(), running: worker?.running, heartbeatAt: worker?.heartbeatAt,
      metricsCoverMediaCommit: Boolean(worker && v.completedAt && new Date(worker.heartbeatAt) >= new Date(v.completedAt)),
      metricsAggregate: worker?.latency || {}, note: "Metrics aggregate this worker process; they are not a per-video trace. createdToMediaCommitSeconds excludes client upload and later public publication." },
  };
  fs.mkdirSync("tmp", { recursive: true, mode: 0o700 });
  const file = `tmp/upload-check-${String(id)}-${crypto.randomUUID()}.json`;
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify(report, null, 2)); console.log("Hesabat:", file);
  if (values.wait && !finished(v)) process.exitCode = 2;
} catch (error) {
  console.error("Upload yoxlaması:", /^[A-Z_]+$/.test(error.message || "") ? error.message : error.code || error.name);
  process.exitCode = 1;
} finally { r2?.destroy(); await mongoose.disconnect(); }
