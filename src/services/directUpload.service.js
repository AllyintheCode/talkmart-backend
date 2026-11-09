import crypto from "node:crypto";
import mongoose from "mongoose";
import { z } from "zod";
import User from "../models/User.js";
import Video from "../models/Video.js";
import Category from "../models/Category.js";
import RateBucket from "../models/RateBucket.js";
import UploadSession from "../models/UploadSession.js";
import { observe } from "../utils/metrics.js";
import { logger } from "../utils/logger.js";
import { DIRECT_MAX_BYTES, DIRECT_PART_BYTES, directError, directPartCount, directPartSize, createDirectMultipart,
  headDirectObject, listDirectParts, signDirectParts, finishDirectMultipart, inspectDirectForCleanup, removeDirectStorage } from "./directUploadStorage.service.js";

const SESSION_MS = 30 * 60000, LOCK_MS = 5 * 60000, RETENTION_MS = 30 * 86400000;
const openStates = ["creating", "uploading", "completing", "closing"];
const extensions = { "video/mp4": ".mp4", "video/quicktime": ".mov", "video/x-msvideo": ".avi", "video/x-matroska": ".mkv" };
const schema = z.object({ title: z.string().trim().max(200).default(""), description: z.string().trim().min(1).max(5000),
  price: z.number().finite().min(0), categoryId: z.string().regex(/^[a-f\d]{24}$/i).transform(value => value.toLowerCase()),
  bytes: z.number().int().min(1).max(DIRECT_MAX_BYTES), contentType: z.enum(Object.keys(extensions)),
}).strict();
let indexes;
const quotaLimit = (name, fallback) => {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw directError(503, "UPLOAD_QUOTA_UNAVAILABLE");
  return value;
};
const eligible = user => ({ _id: user._id, role: "provider", isBlocked: false, emailVerified: true,
  accountStatus: { $ne: "deleting" }, $expr: { $eq: [{ $ifNull: ["$sessionVersion", 1] }, user.sessionVersion ?? 1] }, "providerProfile.verified": true });
const lease = item => ({ _id: item._id, lockId: item.lockId, state: item.state, lockedUntil: { $gt: new Date() } });
const videoPayload = video => Object.fromEntries(["_id", "providerId", "categoryId", "title", "description", "price", "processingStatus", "moderationStatus", "status"].map(key => [key, video[key]]));
async function transaction(work) { const session = await mongoose.startSession(); try { return await session.withTransaction(() => work(session)); } finally { await session.endSession(); } }
async function owned(user, id) {
  if (!/^[a-f\d]{24}$/i.test(String(id))) throw directError(400, "INVALID_UPLOAD_SESSION");
  const item = await UploadSession.findOne({ _id: id, providerId: user._id });
  if (!item) throw directError(404, "UPLOAD_SESSION_NOT_FOUND");
  return item;
}
function requireOpen(item) {
  if (new Date(item.expiresAt).getTime() <= Date.now()) throw directError(410, "UPLOAD_EXPIRED");
  if (item.state !== "uploading") throw directError(openStates.includes(item.state) ? 409 : 410,
    item.state === "creating" ? "UPLOAD_INITIALIZING" : item.state === "completing" ? "UPLOAD_COMPLETING" : "UPLOAD_RESTART_REQUIRED");
}
async function accepted(item, replayed) {
  const video = await Video.findOne({ _id: item._id, providerId: item.providerId, status: { $ne: "deleting" } });
  if (!video) throw directError(410, "UPLOAD_VIDEO_UNAVAILABLE");
  return { completed: true, replayed, video: videoPayload(video), upload: { sessionId: String(item._id), status: "completed" } };
}
async function uploadPayload(item, uploadedParts = [], storageComplete = false) {
  const signed = storageComplete ? { parts: [], urlExpiresAt: null } : await signDirectParts(item, uploadedParts);
  return { sessionId: String(item._id), status: "uploading", mode: "multipart", bytes: item.declaredBytes, contentType: item.contentType,
    partSize: DIRECT_PART_BYTES, partCount: directPartCount(item), expiresAt: item.expiresAt, ...signed, storageComplete,
    uploadedParts: uploadedParts.filter(part => part.Size === directPartSize(item, part.PartNumber))
      .map(part => ({ partNumber: part.PartNumber, bytes: part.Size, etag: part.ETag })) };
}
async function recoverCompleting(user, item) {
  if (item.state === "completing" && item.lockedUntil <= new Date()) {
    await UploadSession.updateOne({ _id: item._id, state: "completing", lockId: item.lockId, lockedUntil: { $lte: new Date() } }, { $set: { state: "uploading", lockId: null, lockedUntil: null } });
    return owned(user, String(item._id));
  }
  return item;
}
export async function initDirectUpload(user, key, body) {
  const started = Date.now();
  try {
    if (process.env.DIRECT_UPLOAD_ENABLED !== "true") throw directError(503, "DIRECT_UPLOAD_DISABLED");
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(key || "")) throw directError(400, "INVALID_UPLOAD_ID");
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw directError(400, "INVALID_DIRECT_UPLOAD");
    const input = parsed.data, requestHash = crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
    indexes ||= UploadSession.createIndexes().catch(error => { indexes = null; throw error; });
    await indexes;
    let item, created = false;
    await transaction(async session => {
      created = false;
      item = await UploadSession.findOne({ providerId: user._id, idempotencyKey: key }).session(session);
      if (item) { if (item.requestHash !== requestHash) throw directError(409, "IDEMPOTENCY_CONFLICT"); return; }
      if (await Video.exists({ providerId: user._id, uploadId: key }).session(session)) throw directError(409, "UPLOAD_ALREADY_ACCEPTED");
      const id = new mongoose.Types.ObjectId(), lockId = crypto.randomUUID(), expiresAt = new Date(Date.now() + SESSION_MS);
      const account = await User.findOneAndUpdate({ ...eligible(user), $or: [{ uploadReservedUntil: null }, { uploadReservedUntil: { $lte: new Date() } }] },
        { $set: { uploadReservation: String(id), uploadReservedUntil: expiresAt } }, { session, returnDocument: "after" });
      if (!account) throw directError(429, "UPLOAD_CONCURRENCY");
      const active = await Video.countDocuments({ providerId: user._id, processingStatus: { $in: ["uploaded", "queued", "processing"] }, status: { $ne: "deleting" } }).session(session);
      const [usage] = await Video.aggregate([{ $match: { providerId: user._id } }, { $group: { _id: null, bytes: { $sum: "$sourceBytes" } } }]).session(session);
      const [pending] = await UploadSession.aggregate([{ $match: { providerId: user._id, state: { $in: openStates } } }, { $group: { _id: null, bytes: { $sum: "$declaredBytes" } } }]).session(session);
      if (active >= 2 || (usage?.bytes || 0) + (pending?.bytes || 0) + input.bytes > quotaLimit("UPLOAD_STORAGE_QUOTA_BYTES", 10 * 1024 ** 3)) throw directError(429, "UPLOAD_QUOTA");
      const category = await Category.findOne({ _id: input.categoryId, status: "active" }).session(session);
      if (!category) throw directError(404, "CATEGORY_NOT_FOUND");
      const daily = quotaLimit("UPLOAD_DAILY_QUOTA_BYTES", 1024 ** 3), reset = (Math.floor(Date.now() / 86400000) + 1) * 86400000;
      if (input.bytes > daily) throw directError(429, "UPLOAD_DAILY_QUOTA");
      const quotaBucketId = `upload-bytes:${user._id}:${reset}`;
      const bucket = await RateBucket.findById(quotaBucketId).session(session);
      if ((bucket?.count || 0) + input.bytes > daily) throw directError(429, "UPLOAD_DAILY_QUOTA");
      await RateBucket.updateOne({ _id: quotaBucketId }, { $inc: { count: input.bytes }, $setOnInsert: { expiresAt: new Date(reset) } }, { session, upsert: true });
      [item] = await UploadSession.create([{ _id: id, providerId: user._id, idempotencyKey: key, requestHash,
        sourceKey: `talkmart/staging/${user._id}/${crypto.randomUUID()}${extensions[input.contentType]}`,
        declaredBytes: input.bytes, contentType: input.contentType, originalExt: extensions[input.contentType],
        title: input.title, description: input.description, price: input.price, categoryId: input.categoryId, categoryName: category.name,
        state: "creating", expiresAt, lockId, lockedUntil: new Date(Date.now() + LOCK_MS), quotaBucketId,
      }], { session });
      created = true;
    });
    if (!created) {
      if (item.state === "completed") return accepted(item, true);
      if (item.state === "creating" && item.lockedUntil <= new Date()) { await closeDirectUpload(item, "failed"); throw directError(410, "UPLOAD_RESTART_REQUIRED"); }
      return { ...await getDirectUpload(user, String(item._id)), replayed: true };
    }
    let storageUploadId;
    try {
      storageUploadId = await createDirectMultipart(item);
      const updated = await UploadSession.findOneAndUpdate(lease(item), { $set: { storageUploadId, state: "uploading", lockId: null, lockedUntil: null } }, { returnDocument: "after" });
      if (!updated) throw directError(409, "UPLOAD_SESSION_CHANGED");
      if (!await User.exists(eligible(user))) throw directError(403, "UPLOAD_ACCOUNT_CHANGED");
      return { replayed: false, upload: await uploadPayload(updated) };
    } catch (error) {
      // Persist a known ID before cleanup if the session still belongs to us.
      if (storageUploadId) await UploadSession.updateOne(lease(item), { $set: { storageUploadId } });
      await UploadSession.updateOne(lease(item), { $set: { lockedUntil: new Date(0) } });
      try { await closeDirectUpload(item, "failed"); } catch (cleanupError) { logger.warn("direct_upload_cleanup_retry", cleanupError); }
      throw error;
    }
  } finally { observe("direct_upload_init_ms", Date.now() - started); }
}
export async function getDirectUpload(user, id) {
  const item = await recoverCompleting(user, await owned(user, id));
  if (item.state === "completed") return accepted(item, true);
  requireOpen(item);
  const head = await headDirectObject(item);
  const parts = head ? [] : await listDirectParts(item);
  if (!await User.exists(eligible(user))) throw directError(403, "UPLOAD_ACCOUNT_CHANGED");
  const upload = await uploadPayload(item, parts, Boolean(head));
  return { upload };
}
export async function completeDirectUpload(user, id) {
  const started = Date.now();
  try {
    let item = await recoverCompleting(user, await owned(user, id));
    if (item.state === "completed") return accepted(item, true);
    requireOpen(item);
    item = await UploadSession.findOneAndUpdate({ _id: item._id, state: "uploading", expiresAt: { $gt: new Date() } },
      { $set: { state: "completing", lockId: crypto.randomUUID(), lockedUntil: new Date(Date.now() + LOCK_MS) } }, { returnDocument: "after" });
    if (!item) throw directError(409, "UPLOAD_COMPLETING");
    try {
      await finishDirectMultipart(item);
      await transaction(async session => {
        if (!await UploadSession.exists(lease(item)).session(session)) throw directError(409, "UPLOAD_SESSION_CHANGED");
        const account = await User.updateOne({ ...eligible(user), uploadReservation: String(item._id) }, { $set: { uploadReservation: null, uploadReservedUntil: null } }, { session });
        if (!account.matchedCount) throw directError(403, "UPLOAD_ACCOUNT_CHANGED");
        const category = await Category.findOne({ _id: item.categoryId, status: "active" }).session(session);
        if (!category) throw directError(409, "CATEGORY_UNAVAILABLE");
        await Video.create([{ _id: item._id, providerId: item.providerId, categoryId: item.categoryId, categoryName: category.name,
          title: item.title, description: item.description, price: item.price, duration: 0, stagingKey: item.sourceKey,
          sourceBytes: item.declaredBytes, originalExt: item.originalExt, uploadId: item.idempotencyKey,
          processingStatus: "queued", moderationStatus: "pending", status: "inactive", schemaVersion: 2,
        }], { session });
        const committed = await UploadSession.updateOne(lease(item), { $set: { state: "completed", quotaSettled: true, chargedBytes: item.declaredBytes,
          cleanupDone: true, lockId: null, lockedUntil: null, purgeAt: new Date(Date.now() + RETENTION_MS) } }, { session });
        if (!committed.matchedCount) throw directError(409, "UPLOAD_SESSION_CHANGED");
      });
      return accepted(item, false);
    } catch (error) {
      // A lost transaction response may have committed both rows atomically.
      const current = await UploadSession.findById(item._id);
      if (current?.state === "completed") return accepted(current, true);
      await UploadSession.updateOne(lease(item), { $set: { state: "uploading", lockId: null, lockedUntil: null } });
      throw error;
    }
  } finally { observe("direct_upload_complete_ms", Date.now() - started); }
}
export async function closeDirectUpload(candidate, reason = "cancelled") {
  let item = await UploadSession.findById(candidate._id);
  if (!item || item.cleanupDone) return item;
  if (item.state === "completed") throw directError(409, "UPLOAD_ALREADY_COMPLETED");
  item = await UploadSession.findOneAndUpdate({ _id: item._id, state: { $in: openStates }, $or: [{ lockedUntil: null }, { lockedUntil: { $lte: new Date() } }] },
    { $set: { state: "closing", closeReason: item.closeReason || reason, lockId: crypto.randomUUID(), lockedUntil: new Date(Date.now() + LOCK_MS) } }, { returnDocument: "after" });
  if (!item) throw directError(409, "UPLOAD_BUSY");
  try {
    // A committed video owns its source even if a database reply was lost.
    if (await Video.exists({ $or: [{ _id: item._id }, { stagingKey: item.sourceKey }] })) throw directError(409, "UPLOAD_SOURCE_REFERENCED");
    const observedBytes = Math.max(item.observedBytes || 0, await inspectDirectForCleanup(item));
    if (!(await UploadSession.updateOne(lease(item), { $max: { observedBytes } })).matchedCount) throw directError(409, "UPLOAD_SESSION_CHANGED");
    await removeDirectStorage(item);
    await transaction(async session => {
      const current = await UploadSession.findOne(lease(item)).session(session);
      if (!current) throw directError(409, "UPLOAD_SESSION_CHANGED");
      if (!current.quotaSettled) await RateBucket.updateOne({ _id: current.quotaBucketId }, { $inc: { count: observedBytes - current.declaredBytes } }, { session });
      await User.updateOne({ _id: current.providerId, uploadReservation: String(current._id) }, { $set: { uploadReservation: null, uploadReservedUntil: null } }, { session });
      const committed = await UploadSession.updateOne(lease(item), { $set: { state: current.closeReason, quotaSettled: true, chargedBytes: observedBytes,
        cleanupDone: true, lockId: null, lockedUntil: null, purgeAt: new Date(Date.now() + RETENTION_MS) } }, { session });
      if (!committed.matchedCount) throw directError(409, "UPLOAD_SESSION_CHANGED");
    });
    return UploadSession.findById(item._id);
  } catch (error) {
    await UploadSession.updateOne(lease(item), { $set: { lockedUntil: new Date(0) } });
    throw error;
  }
}
export async function cancelDirectUpload(user, id) {
  const item = await owned(user, id);
  if (item.state === "completed") throw directError(409, "UPLOAD_ALREADY_COMPLETED");
  const closed = await closeDirectUpload(item);
  if (!closed) throw directError(404, "UPLOAD_SESSION_NOT_FOUND");
  return { upload: { sessionId: String(closed._id), status: closed.state } };
}
export async function expireDirectUploads() {
  const items = await UploadSession.find({ state: { $in: openStates }, $and: [
    { $or: [{ state: "closing" }, { expiresAt: { $lte: new Date() } }, { state: "creating", lockedUntil: { $lte: new Date() } }] },
    { $or: [{ lockedUntil: null }, { lockedUntil: { $lte: new Date() } }] },
  ] }).sort({ expiresAt: 1 }).limit(5);
  for (const item of items) {
    try { await closeDirectUpload(item, item.state === "creating" ? "failed" : "expired"); }
    catch (error) { logger.warn("direct_upload_expiry_retry", { sessionId: item._id }, error); }
  }
}
export async function cleanupOwnerDirectUploads(providerId) {
  const items = await UploadSession.find({ providerId, state: { $in: openStates } }).limit(5);
  for (const item of items) await closeDirectUpload(item, "cancelled");
  return !await UploadSession.exists({ providerId, state: { $in: openStates } });
}
