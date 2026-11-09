import "../setup.js";
import { test, before, beforeEach, after, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffmpeg from "ffmpeg-static";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { S3Client, UploadPartCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import User from "../../src/models/User.js";
import Video from "../../src/models/Video.js";
import Category from "../../src/models/Category.js";
import UploadSession from "../../src/models/UploadSession.js";
import RateBucket from "../../src/models/RateBucket.js";
import { signAccessToken, signPasswordResetToken } from "../../src/utils/jwt.js";

let replica, server, storageServer, origin, storageOrigin, verifier, r2, directR2, direct, processing, cleanup, accountCleanup;
let provider, otherProvider, reader, category, fixture, directory;
let afterComplete, afterCreate, lostComplete, lostCreate, deleteFails, completeCalls;
const uploads = new Map(), objects = new Map();
const partSize = 8 * 1024 * 1024;
const missing = name => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: 404 } });
const token = user => signAccessToken({ id: user._id, sv: user.sessionVersion });
const eTag = bytes => '"' + crypto.createHash("md5").update(bytes).digest("hex") + '"';
const totalQuota = () => RateBucket.findOne({ _id: /^upload-bytes:/ });
const metadata = (bytes = fixture.length) => ({ title: "Cleaning", description: "Synthetic cleaning service", price: 10,
  categoryId: String(category._id), bytes, contentType: "video/mp4" });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function api(route, { method = "GET", body, user = provider, key } = {}) {
  const headers = { authorization: "Bearer " + token(user) };
  if (key) headers["Idempotency-Key"] = key;
  if (body) headers["Content-Type"] = "application/json";
  const response = await fetch(origin + route, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json(), headers: response.headers };
}
const init = (key = "direct-test-0001", body = metadata(), user = provider) => api("/api/videos/upload-init", { method: "POST", body, key, user });
const complete = (id, user = provider) => api("/api/videos/upload-complete", { method: "POST", body: { sessionId: id }, user });
async function put(part, bytes) {
  assert.equal(new URL(part.uploadUrl).origin, storageOrigin);
  return fetch(part.uploadUrl, { method: "PUT", body: bytes });
}
async function sendAll(upload, bytes) {
  for (const part of upload.parts) assert.equal((await put(part, bytes.subarray(part.offset, part.offset + part.bytes))).status, 200);
}
async function storage(command) {
  const { Bucket, Key, Body, UploadId } = command.input, key = `${Bucket}:${Key}`, name = command.constructor.name;
  assert.ok(["test-private", "test-public"].includes(Bucket));
  if (name === "CreateMultipartUploadCommand") {
    const id = crypto.randomUUID(); uploads.set(id, { key, input: command.input, parts: new Map() });
    if (afterCreate) await afterCreate(command);
    if (lostCreate) { lostCreate = false; throw new Error("Lost Create response"); }
    return { UploadId: id };
  }
  if (name === "ListPartsCommand") {
    const upload = uploads.get(UploadId); if (!upload || upload.key !== key) throw missing("NoSuchUpload");
    return { Parts: [...upload.parts].map(([PartNumber, bytes]) => ({ PartNumber, Size: bytes.length, ETag: eTag(bytes) })) };
  }
  if (name === "CompleteMultipartUploadCommand") {
    completeCalls++;
    const upload = uploads.get(UploadId); if (!upload || upload.key !== key) throw missing("NoSuchUpload");
    const parts = command.input.MultipartUpload.Parts;
    for (const part of parts) assert.equal(part.ETag, eTag(upload.parts.get(part.PartNumber)));
    objects.set(key, { body: Buffer.concat(parts.map(part => upload.parts.get(part.PartNumber))), type: upload.input.ContentType, metadata: upload.input.Metadata });
    uploads.delete(UploadId);
    if (afterComplete) await afterComplete(command);
    if (lostComplete) { lostComplete = false; throw new Error("Lost Complete response"); }
    return {};
  }
  if (name === "HeadObjectCommand") {
    const object = objects.get(key); if (!object) throw missing("NotFound");
    return { ContentLength: object.body.length, ContentType: object.type, Metadata: object.metadata };
  }
  if (name === "AbortMultipartUploadCommand") {
    const upload = uploads.get(UploadId); if (!upload || upload.key !== key) throw missing("NoSuchUpload");
    uploads.delete(UploadId); return {};
  }
  if (name === "ListMultipartUploadsCommand") return { Uploads: [...uploads].filter(([, upload]) => upload.key.startsWith(`${Bucket}:${command.input.Prefix}`))
    .map(([id, upload]) => ({ UploadId: id, Key: upload.key.slice(Bucket.length + 1) })) };
  if (name === "DeleteObjectCommand") { if (deleteFails) throw new Error("Synthetic storage outage"); objects.delete(key); return {}; }
  if (name === "PutObjectCommand") {
    const chunks = []; if (Body instanceof Uint8Array) chunks.push(Body); else for await (const chunk of Body) chunks.push(Buffer.from(chunk));
    objects.set(key, { body: Buffer.concat(chunks), type: command.input.ContentType }); return { ETag: "test", $metadata: { httpStatusCode: 200 } };
  }
  if (name === "GetObjectCommand") { if (!objects.has(key)) throw missing("NoSuchKey"); return { Body: Readable.from(objects.get(key).body) }; }
  throw new Error("Unexpected direct test storage command " + name);
}

before(async () => {
  // An actual loopback PUT endpoint verifies the SDK's signature against the
  // received content length and exact query. This is not a Cloudflare emulator.
  storageServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, storageOrigin);
      if (req.method !== "PUT") { res.writeHead(403).end(); return; }
      const [Bucket, ...segments] = decodeURIComponent(url.pathname).slice(1).split("/");
      const Key = segments.join("/"), UploadId = url.searchParams.get("uploadId"), PartNumber = Number(url.searchParams.get("partNumber"));
      const length = Number(req.headers["content-length"]), expiry = Number(url.searchParams.get("X-Amz-Expires"));
      const date = url.searchParams.get("X-Amz-Date");
      if (!/^\d{8}T\d{6}Z$/.test(date || "") || !Number.isInteger(length) || length < 1 || length > partSize || !Number.isInteger(PartNumber) || PartNumber < 1 || PartNumber > 32 || expiry < 1 || expiry > 600) { res.writeHead(403).end(); return; }
      const signingDate = new Date(`${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}T${date.slice(9,11)}:${date.slice(11,13)}:${date.slice(13,15)}Z`);
      if (Date.now() > signingDate.getTime() + expiry * 1000 || signingDate.getTime() > Date.now() + 1000) { res.writeHead(403).end(); return; }
      const expected = new URL(await getSignedUrl(verifier, new UploadPartCommand({ Bucket, Key, UploadId, PartNumber, ContentLength: length }),
        { expiresIn: expiry, signingDate, signableHeaders: new Set(["content-length"]) }));
      const sorted = value => [...value.searchParams].sort(([a], [b]) => a.localeCompare(b));
      if (JSON.stringify(sorted(expected)) !== JSON.stringify(sorted(url))) { res.writeHead(403).end(); return; }
      const upload = uploads.get(UploadId);
      if (!upload || upload.key !== `${Bucket}:${Key}`) { res.writeHead(404).end(); return; }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks); assert.equal(bytes.length, length);
      upload.parts.set(PartNumber, bytes); res.setHeader("ETag", eTag(bytes)); res.writeHead(200).end();
    } catch { if (!res.headersSent) res.writeHead(500).end(); else res.end(); }
  });
  await new Promise(resolve => storageServer.listen(0, "127.0.0.1", resolve));
  storageOrigin = `http://127.0.0.1:${storageServer.address().port}`;
  process.env.R2_ENDPOINT = storageOrigin;
  process.env.SMTP_HOST = "127.0.0.1"; process.env.SMTP_PORT = "1"; process.env.SMTP_USER = ""; process.env.SMTP_PASS = "";
  verifier = new S3Client({ region: "auto", endpoint: storageOrigin, credentials: { accessKeyId: "test-access", secretAccessKey: "test-secret" }, requestChecksumCalculation: "WHEN_REQUIRED" });
  ({ default: r2, directR2 } = await import("../../src/config/r2.js")); mock.method(r2, "send", storage); mock.method(directR2, "send", storage);
  const { default: app } = await import("../../src/app.js");
  direct = await import("../../src/services/directUpload.service.js");
  processing = await import("../../src/services/videoProcessing.service.js");
  cleanup = await import("../../src/services/videoCleanup.service.js");
  accountCleanup = await import("../../src/services/accountCleanup.service.js");
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 }, binary: { downloadDir: path.resolve("node_modules/.cache/mongodb-memory-server") } });
  await mongoose.connect(replica.getUri("talkmart_direct_tests"));
  await Promise.all(Object.values(mongoose.models).map(model => model.init()));
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "talkmart-direct-test-"));
  const file = path.join(directory, "source.mp4");
  await promisify(execFile)(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=160x120:d=1", "-c:v", "libx264", "-threads", "2", "-n", file], { windowsHide: true });
  fixture = await fs.readFile(file);
  server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(async () => {
  await Promise.all(Object.values(mongoose.connection.collections).map(collection => collection.deleteMany({})));
  uploads.clear(); objects.clear(); afterComplete = null; afterCreate = null; lostComplete = false; lostCreate = false; deleteFails = false; completeCalls = 0;
  process.env.DIRECT_UPLOAD_ENABLED = "true";
  delete process.env.UPLOAD_DAILY_QUOTA_BYTES; delete process.env.UPLOAD_STORAGE_QUOTA_BYTES;
  [provider, otherProvider, reader] = await User.create([
    { fullName: "Provider", email: "direct@example.invalid", phone: "direct-one", password: "unused", role: "provider", emailVerified: true, providerProfile: { verified: true } },
    { fullName: "Other", email: "other@example.invalid", phone: "direct-two", password: "unused", role: "provider", emailVerified: true, providerProfile: { verified: true } },
    { fullName: "Reader", email: "reader@example.invalid", phone: "direct-reader", password: "unused", emailVerified: true },
  ]);
  category = await Category.create({ name: "Cleaning", status: "active" });
});
after(async () => {
  for (const instance of [server, storageServer]) if (instance) { instance.closeAllConnections(); await new Promise(resolve => instance.close(resolve)); }
  mock.restoreAll(); r2?.destroy(); directR2?.destroy(); verifier?.destroy();
  await mongoose.disconnect(); await replica?.stop();
  if (directory) { assert.equal(path.dirname(directory), os.tmpdir()); await fs.rm(directory, { recursive: true, force: true }); }
});

test("direct upload is opt-in, validates metadata and isolates provider ownership and token types", async () => {
  process.env.DIRECT_UPLOAD_ENABLED = "false"; assert.equal((await init()).body.error.code, "DIRECT_UPLOAD_DISABLED");
  process.env.DIRECT_UPLOAD_ENABLED = "true";
  assert.equal((await init("key-0001", metadata(), reader)).status, 403);
  for (const fields of [{ bytes: 250 * 1024 * 1024 + 1 }, { bytes: 1.5 }, { categoryId: "wrong" }, { contentType: "text/plain" }, { bucket: "outside" }]) assert.equal((await init("key-0001", { ...metadata(), ...fields })).status, 400);
  const result = await init(); assert.equal(result.status, 201); assert.equal(result.headers.get("cache-control"), "private, no-store");
  const id = result.body.upload.sessionId;
  for (const [route, method, body] of [[`/api/videos/uploads/${id}`, "GET"], [`/api/videos/uploads/${id}`, "DELETE"], ["/api/videos/upload-complete", "POST", { sessionId: id }]]) assert.equal((await api(route, { method, body, user: otherProvider })).status, 404);
  const reset = signPasswordResetToken({ id: provider._id, jti: crypto.randomUUID() });
  const response = await fetch(origin + `/api/videos/uploads/${id}`, { headers: { authorization: "Bearer " + reset } }); assert.equal(response.status, 401);
  await User.updateOne({ _id: provider._id }, { $set: { "providerProfile.verified": false } });
  assert.equal((await api(`/api/videos/uploads/${id}`)).status, 403);
  assert.equal(await Video.countDocuments(), 0);
});

test("concurrent init and retry use one reservation, one multipart upload and one daily charge", async () => {
  const responses = await Promise.all(Array.from({ length: 5 }, () => init()));
  assert.equal(responses.filter(result => result.status === 201).length, 1);
  assert.ok(responses.every(result => [200, 201, 409].includes(result.status)));
  assert.equal(await UploadSession.countDocuments(), 1); assert.equal(uploads.size, 1);
  assert.equal((await totalQuota()).count, fixture.length);
  assert.equal((await init()).body.replayed, true);
  assert.equal((await init("direct-test-0001", { ...metadata(), title: "Different" })).body.error.code, "IDEMPOTENCY_CONFLICT");
  assert.equal((await init("another-key-0001")).body.error.code, "UPLOAD_CONCURRENCY");
});

test("signed parts bind their exact size and operation; completed uploads cannot be overwritten", async () => {
  const { body } = await init(); const part = body.upload.parts[0];
  const url = new URL(part.uploadUrl);
  assert.equal(url.searchParams.get("X-Amz-SignedHeaders"), "content-length;host");
  assert.equal([...url.searchParams.keys()].some(key => key.includes("checksum")), false);
  assert.equal((await put(part, Buffer.alloc(fixture.length + 1))).status, 403);
  const changed = new URL(part.uploadUrl); changed.searchParams.set("partNumber", "2");
  assert.equal((await put({ uploadUrl: changed.href }, fixture)).status, 403);
  assert.equal((await fetch(part.uploadUrl)).status, 403);
  await sendAll(body.upload, fixture);
  assert.equal((await complete(body.upload.sessionId)).status, 201);
  assert.equal((await put(part, fixture)).status, 404);
  const row = await Video.findById(body.upload.sessionId);
  assert.deepEqual(objects.get(`test-private:${row.stagingKey}`).body, fixture);
  assert.equal([...objects.keys()].some(key => key.startsWith("test-public:")), false);
});

test("partial resume issues only missing URLs; duplicate complete creates one durable job", async () => {
  const bytes = Buffer.alloc(partSize + fixture.length); fixture.copy(bytes); // Byte-path fixture; worker validity is a separate test.
  const { body } = await init("resume-key-0001", metadata(bytes.length)); const upload = body.upload;
  await put(upload.parts[0], bytes.subarray(0, partSize));
  assert.equal((await complete(upload.sessionId)).body.error.code, "UPLOAD_INCOMPLETE");
  assert.equal(await Video.countDocuments(), 0);
  const resumed = await api(`/api/videos/uploads/${upload.sessionId}`);
  assert.deepEqual(resumed.body.upload.uploadedParts.map(part => part.partNumber), [1]);
  assert.deepEqual(resumed.body.upload.parts.map(part => part.partNumber), [2]);
  await sendAll(resumed.body.upload, bytes);
  const entered = deferred(), release = deferred(); afterComplete = async () => { entered.resolve(); await release.promise; };
  const first = complete(upload.sessionId); await entered.promise;
  assert.equal((await complete(upload.sessionId)).body.error.code, "UPLOAD_COMPLETING");
  release.resolve(); assert.equal((await first).status, 201);
  const replay = await complete(upload.sessionId); assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true);
  assert.equal(await Video.countDocuments(), 1); assert.equal((await totalQuota()).count, bytes.length);
  assert.deepEqual(objects.get(`test-private:${(await Video.findById(upload.sessionId)).stagingKey}`).body, bytes);
});

test("lost Complete storage response is reconciled, and metadata reaches the actual worker before AI", async () => {
  const { body } = await init(); await sendAll(body.upload, fixture); lostComplete = true;
  assert.equal((await complete(body.upload.sessionId)).status, 201);
  const job = await processing.acquireLease(body.upload.sessionId); assert.equal(job.duration, 0);
  await processing.processVideoJob(job);
  const done = await Video.findById(job._id);
  assert.equal(done.duration, 1); assert.equal(done.processingStatus, "ready"); assert.equal(done.moderationStatus, "review");
  assert.equal(done.status, "inactive"); assert.ok(done.privateVideoKey); assert.equal(done.stagingKey, "");
  assert.equal([...objects.keys()].some(key => key.startsWith("test-public:")), false);
});

test("lost transaction commit response does not refund or recreate a committed video", async () => {
  const { body } = await init(); await sendAll(body.upload, fixture);
  const original = mongoose.startSession.bind(mongoose);
  const patched = mock.method(mongoose, "startSession", async () => { const session = await original(); const run = session.withTransaction.bind(session);
    session.withTransaction = async work => { await run(work); throw new Error("Lost DB commit response"); }; return session; });
  try { const result = await complete(body.upload.sessionId); assert.equal(result.status, 200); assert.equal(result.body.replayed, true); }
  finally { patched.mock.restore(); }
  assert.equal(await Video.countDocuments(), 1); assert.equal((await totalQuota()).count, fixture.length);
});

test("cancel refunds unuploaded bytes once and retry after storage outage preserves observed usage", async () => {
  const bytes = partSize + 100, { body } = await init("cancel-key-0001", metadata(bytes));
  await put(body.upload.parts[0], Buffer.alloc(partSize));
  deleteFails = true; assert.equal((await api(`/api/videos/uploads/${body.upload.sessionId}`, { method: "DELETE" })).status, 503);
  assert.equal((await totalQuota()).count, bytes);
  deleteFails = false;
  assert.equal((await api(`/api/videos/uploads/${body.upload.sessionId}`, { method: "DELETE" })).status, 200);
  assert.equal((await totalQuota()).count, partSize);
  assert.equal((await api(`/api/videos/uploads/${body.upload.sessionId}`, { method: "DELETE" })).status, 200);
  assert.equal((await totalQuota()).count, partSize); assert.equal(uploads.size, 0);
  assert.equal((await complete(body.upload.sessionId)).status, 410);
});

test("expiry cleans unknown Create outcomes and stale completing leases recover an existing object", async () => {
  lostCreate = true; assert.equal((await init()).status, 503);
  assert.equal(uploads.size, 0); assert.equal((await totalQuota()).count, 0);
  assert.equal((await UploadSession.findOne()).state, "failed");
  const { body } = await init("recover-key-0001"); await sendAll(body.upload, fixture);
  const row = await UploadSession.findById(body.upload.sessionId);
  await storage(new (await import("@aws-sdk/client-s3")).CompleteMultipartUploadCommand({ Bucket: "test-private", Key: row.sourceKey, UploadId: row.storageUploadId,
    MultipartUpload: { Parts: [{ PartNumber: 1, ETag: eTag(fixture) }] } }));
  await UploadSession.updateOne({ _id: row._id }, { $set: { state: "completing", lockId: "stale-worker", lockedUntil: new Date(0) } });
  const resumed = await api(`/api/videos/uploads/${row._id}`); assert.equal(resumed.status, 200); assert.equal(resumed.body.upload.storageComplete, true);
  assert.equal((await complete(String(row._id))).status, 201); assert.equal(await Video.countDocuments(), 1);
  assert.equal(uploads.size, 0);
});

test("quota rejection and expiry cannot be bypassed through the direct path", async () => {
  process.env.UPLOAD_DAILY_QUOTA_BYTES = String(fixture.length - 1);
  assert.equal((await init()).body.error.code, "UPLOAD_DAILY_QUOTA"); assert.equal(await UploadSession.countDocuments(), 0);
  delete process.env.UPLOAD_DAILY_QUOTA_BYTES;
  process.env.UPLOAD_STORAGE_QUOTA_BYTES = String(fixture.length - 1);
  assert.equal((await init()).body.error.code, "UPLOAD_QUOTA"); delete process.env.UPLOAD_STORAGE_QUOTA_BYTES;
  const { body } = await init();
  await UploadSession.updateOne({ _id: body.upload.sessionId }, { $set: { expiresAt: new Date(0) } });
  assert.equal((await api(`/api/videos/uploads/${body.upload.sessionId}`)).status, 410);
  assert.equal((await complete(body.upload.sessionId)).status, 410);
  await direct.expireDirectUploads();
  assert.equal((await UploadSession.findById(body.upload.sessionId)).state, "expired");
  assert.equal((await totalQuota()).count, 0); assert.equal(uploads.size, 0);
});

test("blocking during completion fences the queue commit; account deletion cleans originals and sessions", async () => {
  const { body } = await init(); await sendAll(body.upload, fixture);
  afterComplete = async () => { await User.updateOne({ _id: provider._id }, { $set: { isBlocked: true }, $inc: { sessionVersion: 1 } }); };
  assert.equal((await complete(body.upload.sessionId)).body.error.code, "UPLOAD_ACCOUNT_CHANGED"); assert.equal(await Video.countDocuments(), 0);
  const deleted = await accountCleanup.deleteUserCompletely(provider._id);
  await accountCleanup.cleanupDeletedAccount(deleted);
  assert.equal(await User.countDocuments({ _id: provider._id }), 0); assert.equal(await UploadSession.countDocuments(), 0);
  assert.equal(objects.size, 0); assert.equal(uploads.size, 0);
  assert.equal((await totalQuota()).count, fixture.length);
});

test("forged media fails at the worker and deleting an accepted upload cannot resurrect it", async () => {
  const invalid = Buffer.from("not a video"), { body } = await init("forged-key-0001", metadata(invalid.length));
  await sendAll(body.upload, invalid); assert.equal((await complete(body.upload.sessionId)).status, 201);
  const job = await processing.acquireLease(body.upload.sessionId); await processing.processVideoJob(job);
  const failed = await Video.findById(job._id); assert.equal(failed.processingStatus, "failed"); assert.equal(failed.attempt, 1);
  assert.equal([...objects.keys()].some(key => key.startsWith("test-public:")), false);
  await cleanup.markVideoDeleting(job._id); await cleanup.cleanupVideoResources(await Video.findById(job._id));
  assert.equal((await complete(body.upload.sessionId)).status, 410);
  assert.equal((await init("forged-key-0001", metadata(invalid.length))).status, 410);
  assert.equal((await totalQuota()).count, invalid.length); assert.equal(objects.size, 0);
});

test("revocation during multipart creation cannot issue fresh part URLs", async () => {
  afterCreate = async () => { await User.updateOne({ _id: provider._id }, { $inc: { sessionVersion: 1 } }); };
  const response = await init(); assert.equal(response.status, 403); assert.equal(response.body.error.code, "UPLOAD_ACCOUNT_CHANGED");
  assert.equal(response.body.data, null); assert.equal(uploads.size, 0); assert.equal(objects.size, 0);
  assert.equal((await totalQuota()).count, 0);
});

test("refreshed part URL lifetime is bounded by session expiry and old signed URLs expire", async () => {
  const { body } = await init(); const expiresAt = new Date(Date.now() + 2100);
  await UploadSession.updateOne({ _id: body.upload.sessionId }, { $set: { expiresAt } });
  const response = await api(`/api/videos/uploads/${body.upload.sessionId}`);
  assert.equal(response.status, 200);
  const upload = response.body.upload, url = new URL(upload.parts[0].uploadUrl);
  assert.ok(Number(url.searchParams.get("X-Amz-Expires")) <= 2);
  assert.ok(new Date(upload.urlExpiresAt) <= expiresAt);
  await new Promise(resolve => setTimeout(resolve, Math.max(0, new Date(upload.urlExpiresAt) - Date.now()) + 20));
  assert.equal((await put(upload.parts[0], fixture)).status, 403);
});

test("legacy multipart and direct uploads share reservations and accepted idempotency keys", async () => {
  const { body } = await init();
  const busy = await api("/api/videos/upload", { method: "POST", key: "legacy-new-key-0001", body: {} });
  assert.equal(busy.body.error.code, "UPLOAD_CONCURRENCY");
  await sendAll(body.upload, fixture); await complete(body.upload.sessionId);
  const replay = await api("/api/videos/upload", { method: "POST", key: "direct-test-0001", body: {} });
  assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true);
  assert.equal(await Video.countDocuments(), 1); assert.equal((await totalQuota()).count, fixture.length);
  await Video.create({ providerId: provider._id, categoryId: category._id, description: "Other pending job", price: 1, processingStatus: "queued", sourceBytes: 1 });
  assert.equal((await init("third-active-key-0001")).body.error.code, "UPLOAD_QUOTA");
});

test("a rolled-back queue transaction retries the same completed immutable source", async () => {
  const { body } = await init(); await sendAll(body.upload, fixture);
  const patched = mock.method(Video, "create", async () => { throw new Error("Synthetic DB write failure"); });
  try { assert.equal((await complete(body.upload.sessionId)).status, 503); } finally { patched.mock.restore(); }
  assert.equal(await Video.countDocuments(), 0);
  assert.equal((await api(`/api/videos/uploads/${body.upload.sessionId}`)).body.upload.storageComplete, true);
  assert.equal((await complete(body.upload.sessionId)).status, 201);
  assert.equal(completeCalls, 1); assert.equal(await Video.countDocuments(), 1); assert.equal((await totalQuota()).count, fixture.length);
});

test("unexpected completed object size or ownership never enters the video queue", async () => {
  let result = await init(); await sendAll(result.body.upload, fixture);
  afterComplete = async command => { const stored = objects.get(`${command.input.Bucket}:${command.input.Key}`); stored.body = stored.body.subarray(1); };
  assert.equal((await complete(result.body.upload.sessionId)).body.error.code, "UPLOAD_SIZE_OR_TYPE_MISMATCH");
  assert.equal(await Video.countDocuments(), 0);
  assert.equal((await api(`/api/videos/uploads/${result.body.upload.sessionId}`, { method: "DELETE" })).status, 200);
  result = await init("wrong-owner-head-0001"); await sendAll(result.body.upload, fixture);
  afterComplete = async command => { objects.get(`${command.input.Bucket}:${command.input.Key}`).metadata["talkmart-session"] = "unexpected-owner"; };
  assert.equal((await complete(result.body.upload.sessionId)).body.error.code, "UPLOAD_OBJECT_OWNER_MISMATCH");
  assert.equal(await Video.countDocuments(), 0); assert.equal([...objects.keys()].some(key => key.startsWith("test-public:")), false);
});

test("account deletion aborts incomplete direct parts and settles the daily ledger before removing the owner", async () => {
  const { body } = await init("delete-partial-key-0001", metadata(partSize + 100));
  await put(body.upload.parts[0], Buffer.alloc(partSize));
  const deleted = await accountCleanup.deleteUserCompletely(provider._id);
  await accountCleanup.cleanupDeletedAccount(deleted);
  assert.equal(await User.countDocuments({ _id: provider._id }), 0); assert.equal(await UploadSession.countDocuments(), 0);
  assert.equal(uploads.size, 0); assert.equal(objects.size, 0); assert.equal((await totalQuota()).count, partSize);
});

test("init retry racing completion keeps the accepted video at the normal response level", async () => {
  const first = await init(); await sendAll(first.body.upload, fixture);
  const original = mongoose.startSession.bind(mongoose); let armed = true;
  const patched = mock.method(mongoose, "startSession", async () => {
    const session = await original(), run = session.withTransaction.bind(session);
    session.withTransaction = async work => { const result = await run(work); if (armed) { armed = false; await direct.completeDirectUpload(provider, first.body.upload.sessionId); } return result; };
    return session;
  });
  try {
    const replay = await init(); assert.equal(replay.status, 200); assert.equal(replay.body.completed, true);
    assert.equal(replay.body.video._id, first.body.upload.sessionId); assert.equal(replay.body.upload.status, "completed");
  } finally { patched.mock.restore(); }
  assert.equal(await Video.countDocuments(), 1); assert.equal((await totalQuota()).count, fixture.length);
});

test("direct init accepts bounded UTF-8 metadata while oversized JSON and legacy limits remain rejected", async () => {
  const response = await init("unicode-key-0001", { ...metadata(), title: "ə".repeat(200), description: "三".repeat(5000) });
  assert.equal(response.status, 201);
  assert.equal((await init("too-large-key-0001", { ...metadata(), extra: "x".repeat(40000) })).status, 413);
  const legacy = await fetch(origin + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "x".repeat(15000) }) });
  assert.equal(legacy.status, 413);
});

test("invalid quota configuration cannot silently remove direct upload limits", async () => {
  for (const name of ["UPLOAD_STORAGE_QUOTA_BYTES", "UPLOAD_DAILY_QUOTA_BYTES"]) {
    for (const value of ["not-bytes", "0", "-1", "Infinity", "1.5"]) {
      process.env[name] = value;
      const result = await init(); assert.equal(result.status, 503); assert.equal(result.body.error.code, "UPLOAD_QUOTA_UNAVAILABLE");
      assert.equal(await UploadSession.countDocuments(), 0); assert.equal(uploads.size, 0);
    }
    delete process.env[name];
  }
});
