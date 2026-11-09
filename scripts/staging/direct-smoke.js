import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";
import mongoose from "mongoose";
import { openStaging } from "./safety.js";
import { processSnapshot } from "./rollout-safety.js";

const ROOT = "/var/www/backend-perf-test-20261108", INPUT = "/root/talkmart-direct-original.mp4";
const SOURCE_HASH = "ae239bff40cb19d8168c8630d42baaca07bb8e7dfe92de633dcf7339a7689bfb";
const PROVIDER = "6adfd4c4eefbfb98a5fbfa2e", BASE = "https://api.talkmart.az/test-api/api", PART_BYTES = 8 * 1024 * 1024;
export function validateSmokePart(part, bytes, endpoint, bucket, session) {
  const number = part.partNumber, expected = Math.min(PART_BYTES, bytes - (number - 1) * PART_BYTES);
  const url = new URL(part.uploadUrl), origin = new URL(endpoint);
  const virtual = url.hostname === `${bucket}.${origin.hostname}`;
  const objectPath = virtual ? `/${session.sourceKey}` : `/${bucket}/${session.sourceKey}`;
  if (!Number.isInteger(number) || number < 1 || number > Math.ceil(bytes / PART_BYTES) || part.offset !== (number - 1) * PART_BYTES || part.bytes !== expected ||
      part.method !== "PUT" || Object.keys(part.headers || {}).length !== 1 || Number(part.headers?.["Content-Length"]) !== expected ||
      url.protocol !== "https:" || origin.protocol !== "https:" || url.username || url.password || url.port !== origin.port ||
      (!virtual && url.hostname !== origin.hostname) || decodeURIComponent(url.pathname) !== objectPath ||
      url.searchParams.get("uploadId") !== session.storageUploadId || url.searchParams.get("partNumber") !== String(number) ||
      url.searchParams.get("X-Amz-SignedHeaders") !== "content-length;host") throw new Error("UNEXPECTED_DIRECT_PART_SCOPE");
  return part;
}
async function smoke() {
  let before, token, sessionId, accepted = false, stage = "scope";
  let recovering = false;
  const interrupted = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => interrupted.abort());
  const signal = ms => recovering ? AbortSignal.timeout(ms) : AbortSignal.any([AbortSignal.timeout(ms), interrupted.signal]);
  const report = { kind: "staging-direct-upload-smoke", startedAt: new Date().toISOString(), sourceHash: SOURCE_HASH, passed: false, parts: [] };
  const snapshot = () => processSnapshot(JSON.parse(execFileSync("pm2", ["jlist"], { encoding: "utf8", timeout: 15000 })), "new");
  const error = code => Object.assign(new Error(code), { code });
  const hashInput = async () => { const hash = crypto.createHash("sha256"); for await (const chunk of fs.createReadStream(INPUT)) hash.update(chunk); return hash.digest("hex"); };
  const call = async (route, method = "GET", body, key, expected = 200) => {
    const response = await fetch(BASE + route, { method, headers: { ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}), ...(key ? { "Idempotency-Key": key } : {}) },
      body: body ? JSON.stringify(body) : undefined, redirect: "manual", signal: signal(30000) });
    const result = await response.json();
    if (response.status !== expected || result.success !== true) throw error(/^[A-Z_\d]+$/.test(result.error?.code || "") ? result.error.code : "UNEXPECTED_DIRECT_API_RESPONSE");
    return result.data ?? result;
  };
  try {
    await openStaging();
    if (process.env.DIRECT_UPLOAD_ENABLED !== "true") throw error("DIRECT_UPLOAD_NOT_ENABLED");
    before = snapshot();
    if (fs.realpathSync(INPUT) !== INPUT || !fs.lstatSync(INPUT).isFile() || fs.statSync(INPUT).size !== 32350603 || await hashInput() !== SOURCE_HASH) throw error("KNOWN_ORIGINAL_FIXTURE_REQUIRED");
    const credentials = JSON.parse(fs.readFileSync("/var/www/backend-test/tmp/staging-logins.json", "utf8"))
      .find(item => item.role === "provider" && item.email === "provider@talkmart-test.invalid");
    if (!credentials) throw error("STAGING_PROVIDER_CREDENTIALS_MISSING");
    stage = "login";
    const login = await call("/auth/login", "POST", { email: credentials.email, password: credentials.password });
    if (login.user?.id !== PROVIDER || login.user.role !== "provider" || !login.token) throw error("UNEXPECTED_STAGING_PROVIDER");
    token = login.token; console.log("Test provider girisi: OK");
    const bytes = fs.statSync(INPUT).size, key = "direct-smoke-" + crypto.randomUUID();
    const started = performance.now(); stage = "init";
    let time = performance.now();
    const initialized = await call("/videos/upload-init", "POST", { title: "PERF direct təmizlik", description: "Ev təmizliyi xidməti üçün birbaşa R2 test videosu",
      price: 50.5, categoryId: "6adfd4c4eefbfb98a5fbfa2c", bytes, contentType: "video/mp4" }, key, 201);
    report.initMs = performance.now() - time; sessionId = initialized.upload?.sessionId;
    if (!/^[a-f\d]{24}$/.test(sessionId || "")) throw error("INVALID_SESSION_RESPONSE");
    const session = await mongoose.connection.db.collection("uploadsessions").findOne({ _id: new mongoose.Types.ObjectId(sessionId), providerId: new mongoose.Types.ObjectId(PROVIDER) });
    if (!session || !session.sourceKey.startsWith(`talkmart/staging/${PROVIDER}/`)) throw error("UNEXPECTED_SESSION_OWNER");
    const sendPart = async part => {
      validateSmokePart(part, bytes, process.env.R2_ENDPOINT, process.env.R2_STAGING_BUCKET, session);
      const input = fs.createReadStream(INPUT, { start: part.offset, end: part.offset + part.bytes - 1 });
      const partStarted = performance.now();
      try {
        const response = await fetch(part.uploadUrl, { method: "PUT", headers: { "Content-Length": String(part.bytes) }, body: input, duplex: "half", redirect: "manual", signal: signal(120000) });
        await response.arrayBuffer(); if (response.status !== 200) throw error("R2_PART_PUT_FAILED");
        report.parts.push({ number: part.partNumber, bytes: part.bytes, ms: performance.now() - partStarted });
        console.log(`R2 hisse ${part.partNumber}: OK`);
      } finally { input.destroy(); }
    };
    const upload = initialized.upload;
    if (upload.partSize !== PART_BYTES || upload.parts?.length !== Math.ceil(bytes / PART_BYTES) || upload.parts[0].partNumber !== 1) throw error("UNEXPECTED_UPLOAD_PLAN");
    stage = "first_part"; await sendPart(upload.parts[0]);
    stage = "resume"; time = performance.now();
    const resumed = await call(`/videos/uploads/${sessionId}`); report.resumeMs = performance.now() - time;
    if (resumed.upload.uploadedParts?.length !== 1 || resumed.upload.uploadedParts[0].partNumber !== 1 || resumed.upload.parts?.length !== upload.parts.length - 1 || resumed.upload.parts.some(part => part.partNumber === 1)) throw error("RESUME_DID_NOT_PRESERVE_FIRST_PART");
    console.log("Qismen upload ve yalniz catismaýan hisselerle resume: OK");
    stage = "remaining_parts"; for (const part of resumed.upload.parts) await sendPart(part);
    if (await hashInput() !== SOURCE_HASH) throw error("ORIGINAL_CHANGED_DURING_TEST");
    stage = "complete"; time = performance.now();
    const completed = await call("/videos/upload-complete", "POST", { sessionId }, undefined, 201);
    report.completeMs = performance.now() - time; report.totalToQueueMs = performance.now() - started;
    if (String(completed.video?._id) !== sessionId) throw error("VIDEO_ID_CHANGED");
    accepted = true; report.videoId = sessionId;
    stage = "complete_replay";
    const replay = await call("/videos/upload-complete", "POST", { sessionId });
    if (String(replay.video?._id) !== sessionId || replay.replayed !== true || await mongoose.connection.db.collection("videos").countDocuments({ providerId: new mongoose.Types.ObjectId(PROVIDER), uploadId: key }) !== 1) throw error("COMPLETE_REPLAY_CREATED_DUPLICATE");
    report.passed = true; report.idempotentComplete = true; report.sourceBytes = bytes;
    console.log("Complete ve tekrari: bir video/job — OK"); console.log("Video ID:", sessionId);
    console.log("Init:", Math.round(report.initMs), "ms; R2 hisseleri:", Math.round(report.parts.reduce((sum, item) => sum + item.ms, 0)), "ms; complete:", Math.round(report.completeMs), "ms");
    console.log("Bu qebul olcmesidir; AI/emalin bitme vaxti ve telefon sebeke sureti deyil.");
  } catch (failure) {
    recovering = true;
    report.failedAt = stage; report.errorCode = /^[A-Z_\d]+$/.test(failure.code || "") ? failure.code : failure.name;
    console.error("Direct upload sinagi:", stage, report.errorCode); process.exitCode = 1;
    if (sessionId && !accepted && token) {
      try {
        const current = await call(`/videos/uploads/${sessionId}`);
        if (current.upload?.status === "completed") { accepted = true; report.videoId = sessionId; }
        else { await call(`/videos/uploads/${sessionId}`, "DELETE"); report.unfinishedCancelled = true; }
      } catch { report.pendingSessionId = sessionId; }
    }
  } finally {
    if (before) {
      try { const after = snapshot(); for (const item of before) { const now = after.find(row => row.name === item.name); if (now.pid !== item.pid || now.uptime !== item.uptime) throw error("PROCESS_CHANGED"); } report.processIdsPreserved = true; }
      catch { report.passed = false; process.exitCode = 1; console.error("Proses yoxlamasi tamamlanmadi."); }
      report.finishedAt = new Date().toISOString();
      fs.mkdirSync(path.join(ROOT, "tmp"), { recursive: true, mode: 0o700 });
      const output = `tmp/direct-upload-smoke-${crypto.randomUUID()}.json`; fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
      console.log("Hesabat:", output);
    }
    await mongoose.disconnect();
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({ options: { upload: { type: "boolean", default: false }, help: { type: "boolean", default: false } } });
  if (!values.upload || values.help) console.log("node scripts/staging/direct-smoke.js --upload\nStaging only; uploads the known /root/talkmart-direct-original.mp4 fixture. Default/help makes no changes.");
  else await smoke();
}
