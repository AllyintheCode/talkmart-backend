import "../setup.js";
import { test, before, beforeEach, after, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffmpeg from "ffmpeg-static";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import app from "../../src/app.js";
import r2 from "../../src/config/r2.js";
import redis from "../../src/config/redis.js";
import User from "../../src/models/User.js";
import Video from "../../src/models/Video.js";
import Otp from "../../src/models/Otp.js";
import Category from "../../src/models/Category.js";
import Report from "../../src/models/Report.js";
import RateBucket from "../../src/models/RateBucket.js";
import ViewWindow from "../../src/models/ViewWindow.js";
import { VideoLike, VideoSave } from "../../src/models/VideoInteraction.js";
import { signAccessToken, signPasswordResetToken } from "../../src/utils/jwt.js";
import { hashOtp, consumeOtp } from "../../src/utils/otp.js";
import { transporter } from "../../src/utils/email.js";
import { acquireLease, processVideoJob, applyAiResult, recoverStuckVideos } from "../../src/services/videoProcessing.service.js";
import { runMaintenance, reconcileOrphanObjects } from "../../src/services/maintenance.service.js";
import { deliverNextReportNotification } from "../../src/services/reportNotification.service.js";
import { SharedRateStore } from "../../src/middlewares/rateLimit.middleware.js";
import { createVideo } from "../../src/controllers/video.controller.js";
import { publishIfEligible, setAdminDecision } from "../../src/services/videoState.service.js";
import { videoForViewer } from "../../src/services/videoMedia.service.js";

let repl, server, base, directory, input, inputBytes;
let admin, provider, user, category;
let smtpFails = false;
let storageFails = false;
let copyHook = null;
let deleteHook = null;
const objects = new Map();
const approved = { finalStatus: "approved", aiData: { reasoning: "Valid service", confidenceScore: 95 } };
const token = (u) => signAccessToken({ id: u._id, sv: u.sessionVersion });
async function request(url, { method = "GET", body, auth, cookie, idempotencyKey } = {}) {
  const headers = {};
  if (auth) headers.authorization = `Bearer ${auth}`;
  if (cookie) headers.cookie = cookie;
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  if (body && !(body instanceof FormData)) headers["content-type"] = "application/json";
  const response = await fetch(base + url, { method, headers, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined, redirect: "manual" });
  return { status: response.status, body: await response.json(), headers: response.headers };
}
const seedVideo = async (fields = {}) => {
  const id = new mongoose.Types.ObjectId();
  const video = await Video.create({ _id: id, providerId: provider._id, categoryId: category._id, categoryName: category.name, description: "Cleaning service", price: 10,
    videoUrl: `https://media.invalid/talkmart/videos/${id}.mp4`, publicId: `talkmart/videos/${id}.mp4`, processingStatus: "ready", moderationStatus: "approved", status: "active", ...fields });
  if (video.publicId) objects.set(`test-public:${video.publicId}`, inputBytes);
  return video;
};
const privateMedia = (id, suffix = crypto.randomUUID()) => {
  const media = { privateVideoKey: `talkmart/private/videos/${id}/${suffix}.mp4`, privateThumbnailKey: `talkmart/private/thumbnails/${id}/${suffix}.webp` };
  objects.set(`test-private:${media.privateVideoKey}`, inputBytes);
  objects.set(`test-private:${media.privateThumbnailKey}`, Buffer.from("thumbnail"));
  return media;
};

before(async () => {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1 }, binary: { downloadDir: path.resolve("node_modules/.cache/mongodb-memory-server") } });
  await mongoose.connect(repl.getUri(), { dbName: "talkmart_tests" });
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  mock.method(transporter, "sendMail", async () => { if (smtpFails) throw new Error("SMTP unavailable"); return { messageId: "test" }; });
  mock.method(r2, "send", async (command) => {
    if (storageFails) throw new Error("Storage unavailable");
    const { Bucket, Key, Body } = command.input;
    const key = `${Bucket}:${Key}`;
    if (command.constructor.name === "PutObjectCommand") {
      const chunks = [];
      if (Body instanceof Uint8Array) chunks.push(Body); else for await (const chunk of Body) chunks.push(Buffer.from(chunk));
      objects.set(key, Buffer.concat(chunks));
      return { ETag: "test", $metadata: { httpStatusCode: 200 } };
    }
    if (command.constructor.name === "DeleteObjectCommand") { if (deleteHook) await deleteHook(command); objects.delete(key); return {}; }
    if (command.constructor.name === "CopyObjectCommand") {
      const source = decodeURIComponent(command.input.CopySource).replace(/^\/+/, "");
      const slash = source.indexOf("/");
      const stored = objects.get(source.slice(0, slash) + ":" + source.slice(slash + 1));
      if (!stored) throw Object.assign(new Error("NoSuchKey"), { code: "NoSuchKey" });
      objects.set(key, Buffer.from(stored));
      if (copyHook) await copyHook(command);
      return { CopyObjectResult: { ETag: "test" } };
    }
    if (command.constructor.name === "GetObjectCommand") {
      if (!objects.has(key)) throw new Error("NoSuchKey");
      return { Body: Readable.from(objects.get(key)) };
    }
    if (command.constructor.name === "ListObjectsV2Command") return { Contents: [...objects.keys()].filter((item) => item.startsWith(`${Bucket}:${command.input.Prefix}`)).map((item) => ({ Key: item.slice(Bucket.length + 1), LastModified: new Date(Date.now() - 172800000) })) };
    throw new Error(`Unexpected storage command: ${command.constructor.name}`);
  });
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "talkmart-test-"));
  input = path.join(directory, "sample.mp4");
  await promisify(execFile)(ffmpeg, ["-f", "lavfi", "-i", "color=c=blue:s=160x120:d=1", "-c:v", "libx264", "-y", input], { windowsHide: true });
  inputBytes = await fs.readFile(input);
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(async () => {
  await Promise.all(Object.values(mongoose.connection.collections).map((collection) => collection.deleteMany({})));
  objects.clear(); smtpFails = false; storageFails = false; copyHook = null; deleteHook = null;
  const password = await bcrypt.hash("oldPassword1", 4);
  [admin, provider, user] = await User.create([
    { fullName: "Admin", role: "admin", email: "admin@example.test", phone: "1000000001", password, emailVerified: true },
    { fullName: "Provider", role: "provider", email: "provider@example.test", phone: "1000000002", password, emailVerified: true, providerProfile: { verified: true, companyName: "Cleaning", address: "Private address", whatsapp: "1000000002" } },
    { fullName: "User", email: "user@example.test", phone: "1000000003", password, emailVerified: true },
  ]);
  category = await Category.create({ name: "Cleaning" });
});
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  mock.restoreAll(); redis?.disconnect();
  await mongoose.disconnect();
  await repl?.stop();
  if (directory) await fs.rm(directory, { recursive: true, force: true });
});

test("reset tokens fail all protected route families; blocked, deleted and revoked accounts fail immediately", async () => {
  const reset = signPasswordResetToken({ id: user._id, jti: crypto.randomUUID() });
  for (const [url, method] of [["/api/users/account", "DELETE"], ["/api/videos/upload", "POST"], [`/api/videos/${user._id}/like`, "POST"], ["/api/admin/users", "GET"]]) assert.equal((await request(url, { method, auth: reset })).status, 401);
  const access = token(user);
  assert.equal((await request("/api/users/profile", { auth: access })).status, 200);
  assert.equal((await request(`/api/admin/users/${user._id}/block`, { method: "PATCH", auth: token(admin), body: { reason: "test" } })).status, 200);
  assert.equal((await request("/api/users/profile", { auth: access })).status, 403);
  await User.updateOne({ _id: user._id }, { $set: { isBlocked: false } });
  assert.equal((await request("/api/users/profile", { auth: access })).status, 401);
  await User.deleteOne({ _id: user._id });
  assert.equal((await request("/api/users/profile", { auth: access })).status, 401);
});
test("parallel password reset consumes nonce and revokes sessions atomically", async () => {
  const jti = crypto.randomUUID();
  await User.updateOne({ _id: user._id }, { $set: { resetTokenHash: crypto.createHash("sha256").update(jti).digest("hex"), resetTokenExpiresAt: new Date(Date.now() + 60000) } });
  const resetToken = signPasswordResetToken({ id: user._id, jti });
  const results = await Promise.all([1, 2].map(() => request("/api/auth/forgot-password/reset-password", { method: "POST", body: { resetToken, newPassword: "newPassword2" } })));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 401]);
  assert.equal((await request("/api/users/profile", { auth: token(user) })).status, 401);
});
test("OTP maximum attempts and one-time consumption hold under concurrency", async () => {
  const make = () => Otp.create({ email: user.email, purpose: "register", otpHash: hashOtp("register", user.email, "123456"), expiresAt: new Date(Date.now() + 60000) });
  await make();
  await Promise.all(Array.from({ length: 10 }, () => consumeOtp({ email: user.email, purpose: "register", code: "000000" })));
  assert.equal((await Otp.findOne()).attemptsLeft, 0);
  assert.equal((await consumeOtp({ email: user.email, purpose: "register", code: "123456" })).status, 429);
  await Otp.deleteMany({}); await make();
  const results = await Promise.all(Array.from({ length: 10 }, () => consumeOtp({ email: user.email, purpose: "register", code: "123456" })));
  assert.equal(results.filter((r) => r.ok).length, 1);
});
test("lease ownership fences duplicate jobs, active workers and stale results after recovery", async () => {
  const video = await seedVideo({ processingStatus: "queued", status: "inactive", moderationStatus: "pending", stagingKey: "talkmart/staging/source.mp4" });
  const jobs = await Promise.all([acquireLease(video._id), acquireLease(video._id)]);
  assert.equal(jobs.filter(Boolean).length, 1);
  const old = jobs.find(Boolean);
  await recoverStuckVideos();
  assert.equal(await acquireLease(video._id), null);
  await Video.updateOne({ _id: video._id }, { $set: { lockedUntil: new Date(Date.now() - 1000) } });
  const next = await acquireLease(video._id);
  assert.notEqual(next.workerId, old.workerId);
  const media = privateMedia(video._id);
  assert.equal(await applyAiResult(old, approved, media), false);
  assert.equal(await applyAiResult(next, approved, media), true);
  assert.equal(await applyAiResult(next, approved, media), false);
});
test("late AI cannot overwrite admin rejection or hidden visibility; unreadied videos cannot be activated", async () => {
  const video = await seedVideo({ processingStatus: "queued", status: "inactive", moderationStatus: "pending", stagingKey: "talkmart/staging/source.mp4", videoUrl: "" });
  assert.equal((await request(`/api/admin/videos/${video._id}/status`, { method: "PATCH", auth: token(admin), body: { status: "active" } })).status, 409);
  const job = await acquireLease(video._id);
  await request(`/api/admin/videos/${video._id}/moderate`, { method: "PATCH", auth: token(admin), body: { action: "reject", feedback: "Rejected" } });
  await applyAiResult(job, approved, privateMedia(video._id));
  let final = await Video.findById(video._id);
  assert.equal(final.moderationSource, "admin"); assert.equal(final.moderationStatus, "rejected"); assert.equal(final.status, "inactive");
  await request(`/api/admin/videos/${video._id}/moderate`, { method: "PATCH", auth: token(admin), body: { action: "approve" } });
  await request(`/api/admin/videos/${video._id}/status`, { method: "PATCH", auth: token(admin), body: { status: "inactive" } });
  final = await Video.findById(video._id); assert.equal(final.visibility, "hidden"); assert.equal(final.status, "inactive");
});
test("concurrent idempotent like/save updates and retries never drift counters", async () => {
  const video = await seedVideo();
  for (const kind of ["like", "save"]) {
    const results = await Promise.all(Array.from({ length: 10 }, () => request(`/api/videos/${video._id}/${kind}`, { method: "POST", auth: token(user) })));
    assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.body)));
    const Model = kind === "like" ? VideoLike : VideoSave;
    assert.equal(await Model.countDocuments({ videoId: video._id }), 1);
    assert.equal((await Video.findById(video._id))[`${kind}Count`], 1);
    for (let i = 0; i < 2; i++) assert.equal((await request(`/api/videos/${video._id}/${kind}`, { method: "DELETE", auth: token(user) })).status, 200);
    assert.equal((await Video.findById(video._id))[`${kind}Count`], 0);
  }
});
test("guest view repeats share a signed session and count once", async () => {
  const video = await seedVideo();
  const first = await request(`/api/videos/${video._id}/view`, { method: "POST", body: { watchedMs: 2500 } });
  assert.equal(first.body.counted, true);
  const cookie = first.headers.get("set-cookie").split(";")[0];
  for (let i = 0; i < 19; i++) assert.equal((await request(`/api/videos/${video._id}/view`, { method: "POST", body: { watchedMs: 2500 }, cookie })).body.counted, false);
  assert.equal((await Video.findById(video._id)).viewCount, 1);
});
test("guest feeds hide contact and blocked owners, with bounded queries and a uniform error contract", async () => {
  await seedVideo();
  let result = await request("/api/videos/feed");
  assert.equal(result.status, 200); assert.equal(result.body.videos.length, 1);
  assert.equal(result.body.videos[0].provider.phone, undefined); assert.equal(result.body.videos[0].provider.address, undefined);
  assert.equal((await request(`/api/users/provider/${provider._id}/whatsapp`)).status, 401);
  await User.updateOne({ _id: provider._id }, { $set: { isBlocked: true } });
  result = await request("/api/videos/feed"); assert.equal(result.body.videos.length, 0);
  for (const query of ["limit=999999", "page=-1", "sort=wrong", "minPrice=abc", `search=${"x".repeat(101)}`]) {
    result = await request(`/api/videos/explore?${query}`);
    assert.equal(result.status, 400); assert.equal(result.body.success, false); assert.equal(typeof result.body.error.code, "string"); assert.ok(result.body.meta.requestId);
  }
  assert.equal((await request("/api/videos/invalid/public")).status, 400);
});
test("provider verification workflow gates uploads, and unfinished uploads always delete temp files", async () => {
  await User.updateOne({ _id: provider._id }, { $set: { "providerProfile.verified": false } });
  assert.equal((await request("/api/videos/upload", { method: "POST", auth: token(provider) })).status, 403);
  assert.equal((await request(`/api/admin/users/${provider._id}/verify-provider`, { method: "PATCH", auth: token(admin), body: { verified: true } })).status, 200);
  const refreshed = await User.findById(provider._id);
  assert.equal((await request("/api/videos/upload", { method: "POST", auth: token(refreshed) })).status, 400);
  for (const body of [{}, { categoryId: String(category._id), description: "test", price: "bad" }]) {
    const temporary = path.join(directory, crypto.randomUUID() + ".mp4"); await fs.copyFile(input, temporary);
    let code;
    await createVideo({ file: { path: temporary }, user: provider, body }, { status: (status) => { code = status; return { json() {} }; } });
    assert.equal(code, 400); await assert.rejects(fs.stat(temporary));
  }
});

test("admin user lists include email and phone without exposing authentication fields", async () => {
  assert.equal((await request("/api/admin/users")).status, 401);
  assert.equal((await request("/api/admin/users", { auth: token(user) })).status, 403);
  const response = await request("/api/admin/users?limit=50", { auth: token(admin) });
  assert.equal(response.status, 200);
  assert.equal(response.body.users.length, 3);
  for (const account of [admin, provider, user]) {
    const row = response.body.users.find(item => item._id === String(account._id));
    assert.equal(row.email, account.email);
    assert.equal(row.phone, account.phone);
    for (const field of ["password", "sessionVersion", "resetTokenHash", "resetTokenExpiresAt"]) assert.equal(row[field], undefined);
  }
});

test("explore accepts the mobile provider request and filters before pagination", async () => {
  const other = await User.create({ fullName: "Other provider", role: "provider", email: "other@example.test", phone: "other", password: "unused",
    emailVerified: true, providerProfile: { verified: true } });
  const own = await Promise.all(Array.from({ length: 105 }, (_, index) => seedVideo({ createdAt: new Date(Date.UTC(2026, 0, 1) + index * 1000) })));
  for (let index = 0; index < 6; index++) await seedVideo({ providerId: other._id, createdAt: new Date(Date.UTC(2026, 1, 1) + index * 1000) });
  for (const fields of [{ status: "inactive" }, { moderationStatus: "rejected" }, { visibility: "hidden" }, { processingStatus: "processing" }, { videoUrl: "" }]) await seedVideo(fields);
  const expected = [...own].reverse().map(video => String(video._id));
  await VideoLike.create({ userId: user._id, videoId: own.at(-1)._id });
  await VideoSave.create({ userId: user._id, videoId: own.at(-1)._id });
  const query = `limit=100&sort=newest&providerId=${provider._id}&provider=${provider._id}`;
  const first = await request(`/api/videos/explore?page=1&${query}`, { auth: token(user) });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.count, 100);
  assert.equal(first.body.total, 105);
  assert.equal(first.body.totalPages, 2);
  assert.deepEqual(first.body.videos.map(video => video._id), expected.slice(0, 100));
  assert.ok(first.body.videos.every(video => video.provider._id === String(provider._id)));
  assert.equal(first.body.videos[0].isLiked, true);
  assert.equal(first.body.videos[0].isSaved, true);
  assert.equal(first.body.videos[0].provider.email, undefined);
  assert.equal(first.body.videos[0].provider.phone, undefined);
  assert.ok(first.body.nextCursor);
  const second = await request(`/api/videos/explore?page=2&${query}`);
  assert.equal(second.status, 200);
  assert.equal(second.body.total, 105);
  assert.deepEqual(second.body.videos.map(video => video._id), expected.slice(100));
  const cursor = await request(`/api/videos/explore?${query}&cursor=${first.body.nextCursor}`);
  assert.equal(cursor.status, 200);
  assert.deepEqual(cursor.body.videos.map(video => video._id), expected.slice(100));
  for (const path of ["/api/videos/explore", "/api/videos/explore/", "/api/videos/EXPLORE"]) {
    const result = await request(`${path}?limit=100`);
    assert.equal(result.status, 200);
    assert.equal(result.body.count, 100);
    assert.equal(result.body.total, 111);
  }
});

test("explore provider queries preserve visibility and reject invalid identifiers and limits", async () => {
  await seedVideo();
  await seedVideo({ providerId: admin._id });
  const url = `/api/videos/explore?limit=100&providerId=${provider._id}`;
  for (const fields of [{ isBlocked: true }, { accountStatus: "deleting" }, { emailVerified: false }]) {
    await User.updateOne({ _id: provider._id }, { $set: { isBlocked: false, accountStatus: "active", emailVerified: true, ...fields } });
    const result = await request(url);
    assert.equal(result.status, 200);
    assert.equal(result.body.total, 0);
    assert.deepEqual(result.body.videos, []);
  }
  await User.updateOne({ _id: provider._id }, { $set: { emailVerified: true } });
  await User.updateOne({ _id: user._id }, { $set: { blockedUsers: [provider._id] } });
  assert.deepEqual((await request(url, { auth: token(user) })).body.videos, []);
  await User.updateOne({ _id: user._id }, { $set: { blockedUsers: [] } });
  await User.updateOne({ _id: provider._id }, { $set: { blockedUsers: [user._id] } });
  assert.deepEqual((await request(url, { auth: token(user) })).body.videos, []);
  assert.equal((await request(url)).body.videos.length, 1);
  const missing = await request("/api/videos/explore?limit=100&providerId=000000000000000000000000");
  assert.equal(missing.status, 200);
  assert.equal(missing.body.total, 0);
  assert.deepEqual(missing.body.videos, []);
  for (const query of ["providerId=invalid", "providerId=", "providerId=bad&providerId=other", "limit=101", "limit=0", "limit=1.5", "page=102&limit=100"]) {
    assert.equal((await request(`/api/videos/explore?${query}`)).status, 400, query);
  }
  for (const path of ["/api/videos/feed", "/api/videos/my-videos", "/api/videos/liked", "/api/admin/users"]) {
    assert.equal((await request(`${path}?limit=100`, { auth: token(admin) })).status, 400, path);
  }
});

test("explore keeps exact totals, ordering, filters, cursor and personal flags on the bounded owner path", async () => {
  await User.updateOne({ _id: provider._id }, { $set: { "providerProfile.address": "Baku [A]." } });
  const other = await User.create({ fullName: "Other provider", role: "provider", email: "other@example.test", phone: "other", password: "unused",
    emailVerified: true, providerProfile: { verified: true, address: "Baku A0" } });
  const rows = [];
  for (let index = 0; index < 18; index++) rows.push(await seedVideo({ providerId: index % 2 ? other._id : provider._id,
    title: "Cleaning " + index, price: index % 4, viewCount: index, createdAt: new Date(Date.UTC(2026, 0, 1) + index * 1000),
    ...(index === 4 ? { moderationStatus: "rejected" } : {}), ...(index === 5 ? { visibility: "hidden" } : {}),
    ...(index === 6 ? { processingStatus: "processing" } : {}) }));
  await Video.collection.insertOne({ ...rows[0].toObject(), _id: new mongoose.Types.ObjectId(), providerId: String(provider._id) });
  await Video.collection.insertOne({ ...rows[0].toObject(), _id: new mongoose.Types.ObjectId(), providerId: new mongoose.Types.ObjectId() });
  const eligible = rows.filter(row => row.moderationStatus === "approved" && row.visibility !== "hidden" && row.processingStatus === "ready");
  const newest = (a, b) => b.createdAt - a.createdAt || String(b._id).localeCompare(String(a._id));
  const ids = list => list.map(row => String(row._id));
  for (const [sort, compare] of [["newest", newest], ["price_low", (a, b) => a.price - b.price || String(b._id).localeCompare(String(a._id))],
    ["price_high", (a, b) => b.price - a.price || String(b._id).localeCompare(String(a._id))], ["trending", (a, b) => b.viewCount - a.viewCount]]) {
    const response = await request(`/api/videos/explore?limit=3&page=2&sort=${sort}`);
    assert.equal(response.status, 200); assert.equal(response.body.total, eligible.length);
    assert.deepEqual(ids(response.body.videos), ids([...eligible].sort(compare).slice(3, 6)));
    if (sort !== "newest") assert.equal(response.body.nextCursor, null);
  }
  const filtered = await request("/api/videos/explore?limit=50&location=" + encodeURIComponent("[A].") + "&minPrice=1&maxPrice=3&search=cleaning&categoryId=" + category._id);
  const expected = eligible.filter(row => String(row.providerId) === String(provider._id) && row.price >= 1 && row.price <= 3).sort(newest);
  assert.equal(filtered.body.total, expected.length); assert.deepEqual(ids(filtered.body.videos), ids(expected));
  const first = await request("/api/videos/explore?limit=3");
  const second = await request("/api/videos/explore?limit=3&cursor=" + first.body.nextCursor);
  assert.deepEqual(ids(second.body.videos), ids([...eligible].sort(newest).slice(3, 6)));
  assert.equal(second.body.total, eligible.length - 3);
  await User.updateOne({ _id: user._id }, { $set: { blockedUsers: [other._id] } });
  await VideoLike.create({ userId: user._id, videoId: rows[16]._id });
  const personal = await request("/api/videos/explore?limit=50", { auth: token(user) });
  const permitted = eligible.filter(row => String(row.providerId) === String(provider._id)).sort(newest);
  assert.deepEqual(ids(personal.body.videos), ids(permitted)); assert.equal(personal.body.total, permitted.length);
  assert.equal(personal.body.videos.find(row => row._id === String(rows[16]._id)).isLiked, true);
  assert.equal(personal.body.videos[0].provider.phone, undefined);
});

test("explore rechecks an owner blocked after counting and bounds its fallback above 1000 owners", async () => {
  await seedVideo();
  const original = Video.aggregate.bind(Video);
  let injected = false;
  const mocked = mock.method(Video, "aggregate", (...args) => {
    const aggregate = original(...args);
    if (!args[0].some(stage => stage.$group) && !injected) {
      injected = true;
      const execute = aggregate.exec.bind(aggregate);
      aggregate.exec = async () => { await User.updateOne({ _id: provider._id }, { $set: { isBlocked: true } }); return execute(); };
    }
    return aggregate;
  });
  try { assert.equal((await request("/api/videos/explore")).body.videos.length, 0); }
  finally { mocked.mock.restore(); }
  const owners = Array.from({ length: 1001 }, (_, index) => ({ _id: new mongoose.Types.ObjectId(), fullName: "Owner " + index,
    email: `owner${index}@example.test`, phone: "owner-" + index, password: "unused", role: "provider", emailVerified: true, isBlocked: index === 0 }));
  await User.collection.insertMany(owners);
  const videos = owners.map((owner, index) => ({ _id: new mongoose.Types.ObjectId(), providerId: owner._id, categoryId: category._id, title: "Fallback",
    description: "Fallback", price: 1, videoUrl: "https://media.invalid/fallback.mp4", status: "active", processingStatus: "ready", moderationStatus: "approved",
    visibility: "public", createdAt: new Date(Date.UTC(2026, 0, 1) + index * 1000) }));
  await Video.collection.insertMany(videos);
  const response = await request("/api/videos/explore?limit=5");
  assert.equal(response.status, 200); assert.equal(response.body.total, 1000);
  assert.deepEqual(response.body.videos.map(row => row._id), videos.slice(-5).reverse().map(row => String(row._id)));
});
test("upload persists private staging and a worker completes media without an API process queue", async () => {
  const form = new FormData();
  form.set("categoryId", String(category._id)); form.set("description", "Cleaning"); form.set("price", "12");
  form.set("video", new Blob([inputBytes], { type: "video/mp4" }), "sample.mp4");
  const result = await request("/api/videos/upload", { method: "POST", auth: token(provider), body: form });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  const stored = await Video.findById(result.body.video._id);
  assert.equal(stored.processingStatus, "queued"); assert.ok(objects.has(`test-private:${stored.stagingKey}`));
  assert.ok(!objects.has(`test-public:${stored.stagingKey}`));
  const job = await acquireLease(stored._id);
  await processVideoJob(job);
  const final = await Video.findById(stored._id);
  assert.equal(final.processingStatus, "ready"); assert.equal(final.moderationStatus, "review"); assert.equal(final.status, "inactive");
  assert.equal(final.videoUrl, ""); assert.equal(final.stagingKey, "");
  assert.ok(objects.has(`test-private:${final.privateVideoKey}`));
  assert.ok(objects.has(`test-private:${final.privateThumbnailKey}`));
  assert.equal([...objects.keys()].some(key => key.startsWith("test-public:")), false);
  const preview = await request("/api/videos/my-videos", { auth: token(provider) });
  assert.equal(preview.headers.get("cache-control"), "private, no-store");
  const link = new URL(preview.body.videos[0].videoUrl);
  assert.ok(link.pathname.startsWith("/test-private/") || link.hostname.startsWith("test-private."));
  assert.equal(link.searchParams.get("X-Amz-Expires"), "600");
  await assert.rejects(videoForViewer(final, user), /PRIVATE_MEDIA_FORBIDDEN/);
});
test("deletion remains queued during storage outage, then removes media and dependent records", async () => {
  const video = await seedVideo();
  await VideoLike.create({ videoId: video._id, userId: user._id });
  objects.set(`test-public:${video.publicId}`, Buffer.from("media"));
  storageFails = true;
  assert.equal((await request(`/api/videos/${video._id}`, { method: "DELETE", auth: token(provider) })).status, 200);
  await runMaintenance(); assert.equal((await Video.findById(video._id)).status, "deleting");
  storageFails = false; await runMaintenance();
  assert.equal(await Video.findById(video._id), null); assert.equal(await VideoLike.countDocuments(), 0); assert.equal(objects.size, 0);
});

test("private media only becomes public on approval; reject/hide revoke origin objects and previews remain scoped", async () => {
  const id = new mongoose.Types.ObjectId(), media = privateMedia(id);
  const video = await seedVideo({ _id: id, ...media, videoUrl: "", publicId: "", moderationStatus: "review", status: "inactive" });
  assert.equal((await request(`/api/videos/${id}/public`)).status, 404);
  assert.equal([...objects.keys()].some(key => key.startsWith("test-public:")), false);
  let response = await request(`/api/admin/videos/${id}/moderate`, { method: "PATCH", auth: token(admin), body: { action: "approve" } });
  assert.equal(response.status, 200); assert.equal(response.body.video.status, "active");
  let current = await Video.findById(id), previous = current.publicId;
  assert.ok(objects.has(`test-public:${previous}`));
  assert.ok(objects.has(`test-private:${media.privateVideoKey}`));
  await request(`/api/admin/videos/${id}/moderate`, { method: "PATCH", auth: token(admin), body: { action: "reject" } });
  current = await Video.findById(id);
  assert.equal(current.publicId, ""); assert.equal(current.videoUrl, "");
  assert.equal(objects.has(`test-public:${previous}`), false);
  assert.equal((await request(`/api/videos/${id}/public`)).status, 404);
  await request(`/api/admin/videos/${id}/moderate`, { method: "PATCH", auth: token(admin), body: { action: "approve" } });
  current = await Video.findById(id); assert.notEqual(current.publicId, previous);
  previous = current.publicId;
  await request(`/api/admin/videos/${id}/status`, { method: "PATCH", auth: token(admin), body: { status: "inactive" } });
  assert.equal(objects.has(`test-public:${previous}`), false);
  await runMaintenance();
  assert.equal((await Video.findById(id)).visibility, "hidden");
  response = await request(`/api/admin/videos/${id}/status`, { method: "PATCH", auth: token(admin), body: { status: "active" } });
  assert.equal(response.body.video.status, "active");
  assert.ok((await videoForViewer(video, provider)).videoUrl.includes("X-Amz-Signature"));
});

test("admin rejection during publication fences the result and removes the attempted public copy", async () => {
  const id = new mongoose.Types.ObjectId();
  await seedVideo({ _id: id, ...privateMedia(id), videoUrl: "", publicId: "", status: "inactive" });
  let injected = false;
  copyHook = async command => {
    if (!injected && command.input.Bucket === "test-public") {
      injected = true;
      await setAdminDecision(id, "reject", admin._id, "Concurrent rejection");
    }
  };
  await publishIfEligible(id);
  const current = await Video.findById(id);
  assert.equal(current.moderationStatus, "rejected"); assert.equal(current.status, "inactive");
  assert.equal(current.videoUrl, "");
  assert.equal([...objects.keys()].some(key => key.startsWith("test-public:")), false);
});

test("failed publication compensates copies; an ambiguous successful commit preserves referenced media", async () => {
  const id = new mongoose.Types.ObjectId();
  await seedVideo({ _id: id, ...privateMedia(id), videoUrl: "", publicId: "", status: "inactive" });
  copyHook = async () => { throw new Error("Lost copy response"); };
  await assert.rejects(publishIfEligible(id));
  assert.equal([...objects.keys()].some(key => key.startsWith("test-public:")), false);
  assert.equal((await Video.findById(id)).status, "inactive");
  copyHook = null;
  const original = Video.findOneAndUpdate.bind(Video);
  let injected = false;
  const mocked = mock.method(Video, "findOneAndUpdate", async (filter, update, options) => {
    const result = await original(filter, update, options);
    if (!injected && update.$set?.publicId && update.$set?.status === "active") { injected = true; throw new Error("Lost publish commit response"); }
    return result;
  });
  try { await assert.rejects(publishIfEligible(id)); } finally { mocked.mock.restore(); }
  const current = await Video.findById(id);
  assert.equal(current.status, "active");
  assert.ok(objects.has(`test-public:${current.publicId}`));
  assert.ok(objects.has(`test-public:${current.thumbnailPublicId}`));
});

test("legacy rejection retries private quarantine after a storage outage; private references survive orphan cleanup", async () => {
  const video = await seedVideo(), oldKey = video.publicId;
  storageFails = true;
  assert.equal((await request(`/api/admin/videos/${video._id}/moderate`, { method: "PATCH", auth: token(admin), body: { action: "reject" } })).status, 200);
  assert.equal((await request(`/api/videos/${video._id}/public`)).status, 404);
  assert.equal((await Video.findById(video._id)).mediaRevocationPending, true);
  storageFails = false;
  await runMaintenance();
  const current = await Video.findById(video._id);
  assert.ok(current.privateVideoKey); assert.equal(current.videoUrl, "");
  assert.equal(objects.has(`test-public:${oldKey}`), false);
  objects.set("test-private:talkmart/private/videos/unreferenced.mp4", inputBytes);
  await reconcileOrphanObjects();
  assert.ok(objects.has(`test-private:${current.privateVideoKey}`));
  assert.equal(objects.has("test-private:talkmart/private/videos/unreferenced.mp4"), false);
  await request(`/api/videos/${video._id}`, { method: "DELETE", auth: token(provider) });
  await runMaintenance();
  assert.equal(await Video.findById(video._id), null);
  assert.equal(objects.has(`test-private:${current.privateVideoKey}`), false);
});

test("revocation survives a failed delete after unlinking public URLs, including missing legacy thumbnails", async () => {
  const video = await seedVideo({ thumbnail: "https://media.invalid/talkmart/thumbnails/missing.webp", thumbnailPublicId: "talkmart/thumbnails/missing.webp" });
  const oldKey = video.publicId;
  deleteHook = async command => { if (command.input.Bucket === "test-public" && command.input.Key === oldKey) throw new Error("Delete unavailable"); };
  await setAdminDecision(video._id, "reject", admin._id);
  let current = await Video.findById(video._id);
  assert.equal(current.videoUrl, ""); assert.equal(current.mediaRevocationPending, true);
  assert.ok(current.publicDeletionKeys.includes(oldKey)); assert.ok(current.privateVideoKey);
  assert.equal(current.privateThumbnailKey, "");
  assert.ok(objects.has(`test-public:${oldKey}`));
  const backlog = await request("/api/admin/operations", { auth: token(admin) });
  assert.equal(backlog.status, 200); assert.equal(backlog.body.mediaRevocationBacklog, 1);
  const preview = await videoForViewer(current, provider);
  assert.ok(preview.videoUrl.includes("X-Amz-Signature"));
  assert.equal("privateVideoKey" in preview, false); assert.equal("publicDeletionKeys" in preview, false);
  deleteHook = null;
  await runMaintenance();
  current = await Video.findById(video._id);
  assert.equal(current.mediaRevocationPending, false); assert.equal(current.publicDeletionKeys.length, 0);
  assert.equal(objects.has(`test-public:${oldKey}`), false);
  assert.equal((await request("/api/admin/operations", { auth: token(admin) })).body.mediaRevocationBacklog, 0);
  await setAdminDecision(video._id, "approve", admin._id);
  assert.equal((await Video.findById(video._id)).status, "active");
});
test("account deletion revokes immediately and cascades with report anonymization", async () => {
  const video = await seedVideo();
  await Report.create({ reporterId: user._id, reportedUserId: provider._id, videoId: video._id, reason: "test", details: "private" });
  assert.equal((await request("/api/users/account", { method: "DELETE", auth: token(provider) })).status, 200);
  assert.equal((await request("/api/users/provider", { auth: token(provider) })).status, 401);
  await runMaintenance();
  assert.equal(await User.findById(provider._id), null); assert.equal(await Video.countDocuments(), 0);
  const report = await Report.findOne(); assert.equal(report.details, "[anonymized]"); assert.equal(report.reportedUserId, null);
});
test("report outbox retries SMTP failure and preserves admin decision history", async () => {
  smtpFails = true;
  assert.equal((await request("/api/users/report", { method: "POST", auth: token(user), body: { reportedUserId: String(provider._id), reason: "test" } })).status, 200);
  let report = await Report.findOne(); assert.equal(report.notificationStatus, "pending");
  await deliverNextReportNotification(); report = await Report.findById(report._id); assert.equal(report.notificationStatus, "pending"); assert.equal(report.notificationAttempts, 1);
  smtpFails = false; await Report.updateOne({ _id: report._id }, { $set: { notificationNextAt: new Date(0) } });
  await deliverNextReportNotification(); assert.equal((await Report.findById(report._id)).notificationStatus, "sent");
  const result = await request(`/api/admin/reports/${report._id}`, { method: "PATCH", auth: token(admin), body: { status: "resolved", note: "Reviewed" } });
  assert.equal(result.status, 200); assert.equal(result.body.report.history[0].action, "resolved"); assert.equal(result.body.report.resolvedBy, String(admin._id));
});
test("public content version changes immediately after admin edits; admin users are paginated", async () => {
  const first = await request("/api/categories");
  assert.equal((await request(`/api/admin/categories/${category._id}`, { method: "PUT", auth: token(admin), body: { status: "inactive" } })).status, 200);
  const next = await request("/api/categories"); assert.equal(next.body.categories.length, 0); assert.ok(next.body.contentVersion > first.body.contentVersion);
  const users = await request("/api/admin/users?limit=1", { auth: token(admin) });
  assert.equal(users.body.users.length, 1);
  const account = [admin, provider, user].find(item => String(item._id) === users.body.users[0]._id);
  assert.equal(users.body.users[0].email, account.email);
  assert.equal(users.body.users[0].phone, account.phone);
});
test("rate limit counts are shared across instances and cannot be bypassed by rotating emails", async () => {
  const a = new SharedRateStore("test"), b = new SharedRateStore("test"); a.init({ windowMs: 60000 }); b.init({ windowMs: 60000 });
  const hits = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).increment("same")));
  assert.equal(Math.max(...hits.map((h) => h.totalHits)), 10);
  let result;
  for (let i = 0; i < 31; i++) result = await request("/api/auth/login", { method: "POST", body: { email: `rotate${i}@example.test`, password: "wrong" } });
  assert.equal(result.status, 429); assert.ok(result.headers.get("retry-after"));
});
test("orphan reconciliation removes unreferenced media while retaining current references", async () => {
  const video = await seedVideo();
  objects.set(`test-public:${video.publicId}`, Buffer.from("referenced")); objects.set("test-public:talkmart/videos/orphan.mp4", Buffer.from("orphan"));
  await reconcileOrphanObjects();
  assert.ok(objects.has(`test-public:${video.publicId}`)); assert.ok(!objects.has("test-public:talkmart/videos/orphan.mp4"));
});
test("orphan reconciliation retains legacy thumbnails referenced only by URL", async () => {
  const key = "talkmart/thumbnails/legacy.webp";
  await seedVideo({ thumbnail: `https://media.invalid/${key}`, thumbnailPublicId: "" });
  objects.set(`test-public:${key}`, Buffer.from("referenced legacy thumbnail"));
  objects.set("test-public:talkmart/thumbnails/orphan.webp", Buffer.from("orphan"));
  await reconcileOrphanObjects();
  assert.ok(objects.has(`test-public:${key}`));
  assert.ok(!objects.has("test-public:talkmart/thumbnails/orphan.webp"));
});
test("publication reconciliation completes a crash after the durable media/decision commit", async () => {
  const video = await seedVideo({ status: "inactive" });
  await runMaintenance();
  assert.equal((await Video.findById(video._id)).status, "active");
});
test("an ambiguous DB response after media commit cannot delete referenced output", async () => {
  const video = await seedVideo({ status: "inactive", processingStatus: "queued", moderationStatus: "pending", stagingKey: "talkmart/staging/ambiguous.mp4", videoUrl: "", publicId: "" });
  objects.set(`test-private:${video.stagingKey}`, inputBytes);
  const job = await acquireLease(video._id);
  const original = Video.updateOne.bind(Video);
  let injected = false;
  const mocked = mock.method(Video, "updateOne", async (filter, update, options) => {
    const result = await original(filter, update, options);
    if (!injected && update.$set?.processingStatus === "ready") { injected = true; throw new Error("Lost commit response"); }
    return result;
  });
  try { await processVideoJob(job); } finally { mocked.mock.restore(); }
  const final = await Video.findById(video._id);
  assert.equal(final.processingStatus, "ready");
  assert.ok(objects.has(`test-private:${final.privateVideoKey}`));
});
test("cursor pages do not duplicate users and a daily quota rejects before accepting a file", async () => {
  const first = await request("/api/admin/users?limit=1", { auth: token(admin) });
  const second = await request(`/api/admin/users?limit=1&cursor=${first.body.nextCursor}`, { auth: token(admin) });
  assert.equal(second.status, 200); assert.notEqual(first.body.users[0]._id, second.body.users[0]._id);
  const previous = process.env.UPLOAD_DAILY_QUOTA_BYTES;
  process.env.UPLOAD_DAILY_QUOTA_BYTES = "1";
  try { assert.equal((await request("/api/videos/upload", { method: "POST", auth: token(provider) })).status, 429); }
  finally { if (previous === undefined) delete process.env.UPLOAD_DAILY_QUOTA_BYTES; else process.env.UPLOAD_DAILY_QUOTA_BYTES = previous; }
});
test("upload replay uses one durable job and deleting it cannot erase daily byte usage", async () => {
  const form = new FormData();
  form.set("categoryId", String(category._id)); form.set("description", "Cleaning"); form.set("price", "12");
  form.set("video", new Blob([inputBytes], { type: "video/mp4" }), "sample.mp4");
  const first = await request("/api/videos/upload", { method: "POST", auth: token(provider), body: form, idempotencyKey: "same-upload-123" });
  assert.equal(first.status, 201);
  const replay = await request("/api/videos/upload", { method: "POST", auth: token(provider), idempotencyKey: "same-upload-123" });
  assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true); assert.equal(await Video.countDocuments(), 1);
  await request(`/api/videos/${first.body.video._id}`, { method: "DELETE", auth: token(provider) });
  await runMaintenance();
  const ledger = await RateBucket.findOne({ _id: { $regex: `^upload-bytes:${provider._id}:` } });
  assert.equal(ledger.count, inputBytes.length);
});
test("versioned migration dry-run, apply and rollback operate on the isolated test database", async () => {
  const id = new mongoose.Types.ObjectId();
  const createdAt = new Date();
  await Video.collection.insertOne({ _id: id, providerId: provider._id, categoryId: category._id, description: "legacy", price: 1, videoUrl: "media", status: "active", createdAt, updatedAt: createdAt });
  const exec = promisify(execFile);
  const options = { env: { ...process.env, MONGO_URI: repl.getUri("talkmart_tests") }, windowsHide: true };
  await exec(process.execPath, ["scripts/migrate-video-state.js"], options);
  assert.equal((await Video.collection.findOne({ _id: id })).schemaVersion, undefined);
  await fs.mkdir("tmp/migrations", { recursive: true });
  const previous = new Set(await fs.readdir("tmp/migrations"));
  await exec(process.execPath, ["scripts/migrate-video-state.js", "--apply"], options);
  const snapshot = (await fs.readdir("tmp/migrations")).find((name) => !previous.has(name));
  const final = await Video.collection.findOne({ _id: id });
  assert.equal(final.schemaVersion, 2); assert.equal(final.moderationStatus, "review"); assert.equal(final.status, "inactive");
  await exec(process.execPath, ["scripts/migrate-video-state.js", "--rollback", path.join("tmp/migrations", snapshot), "--apply"], options);
  const restored = await Video.collection.findOne({ _id: id });
  assert.equal(restored.schemaVersion, undefined); assert.equal(restored.status, "active");
});

test("migration previews leave collections, indexes and legacy records unchanged", async () => {
  const dbName = "talkmart_migration_readonly";
  const db = mongoose.connection.getClient().db(dbName);
  const exec = promisify(execFile);
  const options = { env: { ...process.env, MONGO_URI: repl.getUri(dbName) }, windowsHide: true, timeout: 20000 };
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "talkmart-migration-preview-"));
  const metadata = async () => {
    const collections = (await db.listCollections({}, { nameOnly: true }).toArray()).map(item => item.name).sort();
    return Promise.all(collections.map(async name => ({ name, indexes: (await db.collection(name).indexes()).sort((a, b) => a.name.localeCompare(b.name)) })));
  };
  try {
    assert.deepEqual(await metadata(), []);
    await exec(process.execPath, ["scripts/migrate-video-state.js"], options);
    assert.deepEqual(await metadata(), [], "Preview must not create an empty collection or its indexes");
    const id = new mongoose.Types.ObjectId();
    const legacy = { _id: id, providerId: provider._id, categoryId: category._id, description: "legacy", price: 1, videoUrl: "media", status: "active" };
    await db.collection("videos").insertOne(legacy);
    await db.collection("videos").createIndex({ price: -1 }, { name: "existing_price_desc" });
    const before = await metadata();
    await exec(process.execPath, ["scripts/migrate-video-state.js"], options);
    assert.deepEqual(await metadata(), before, "Preview must preserve existing indexes");
    assert.deepEqual(await db.collection("videos").findOne({ _id: id }), legacy);
    const snapshot = path.join(directory, "rollback.jsonl");
    await fs.writeFile(snapshot, mongoose.mongo.BSON.EJSON.stringify({ id, migrationAt: new Date(), previous: { status: "active" }, missing: [] }) + "\n");
    await exec(process.execPath, ["scripts/migrate-video-state.js", "--rollback", snapshot], options);
    assert.deepEqual(await metadata(), before, "Rollback preview must preserve existing indexes");
    assert.deepEqual(await db.collection("videos").findOne({ _id: id }), legacy);
  } finally {
    await db.dropDatabase();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
