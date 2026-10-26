import crypto from "node:crypto";
import User from "../models/User.js";
import Video from "../models/Video.js";
import RateBucket from "../models/RateBucket.js";
import { fail } from "../utils/http.js";

export async function uploadQuota(req, res, next) {
  const uploadId = req.get("Idempotency-Key");
  if (uploadId && !/^[a-zA-Z0-9_-]{8,100}$/.test(uploadId)) return fail(res, 400, "INVALID_UPLOAD_ID", "Invalid Idempotency-Key");
  if (uploadId) {
    const existing = await Video.findOne({ providerId: req.user._id, uploadId }).select("_id processingStatus moderationStatus status");
    if (existing) return res.status(200).json({ success: true, video: existing, replayed: true });
  }
  req.uploadId = uploadId || null;
  const reservation = crypto.randomUUID();
  const user = await User.findOneAndUpdate({
    _id: req.user._id, isBlocked: false, accountStatus: { $ne: "deleting" },
    "providerProfile.verified": true,
    $or: [{ uploadReservedUntil: null }, { uploadReservedUntil: { $lte: new Date() } }],
  }, { $set: { uploadReservation: reservation, uploadReservedUntil: new Date(Date.now() + 900000) } }, { returnDocument: "after" });
  if (!user) {
    res.setHeader("Retry-After", "30");
    return fail(res, 429, "UPLOAD_CONCURRENCY", "Another upload is in progress");
  }
  let released = false;
  let dailyReservation;
  const heartbeat = setInterval(() => {
    User.updateOne({ _id: user._id, uploadReservation: reservation }, { $set: { uploadReservedUntil: new Date(Date.now() + 900000) } }).catch(() => {});
  }, 30000);
  heartbeat.unref();
  req.releaseUpload = async () => {
    if (released) return;
    released = true;
    clearInterval(heartbeat);
    await User.updateOne({ _id: user._id, uploadReservation: reservation }, { $set: { uploadReservation: null, uploadReservedUntil: null } });
    if (dailyReservation) {
      const actual = Math.min(250 * 1024 * 1024, req.file?.size || 0);
      await RateBucket.updateOne({ _id: dailyReservation }, { $inc: { count: actual - 250 * 1024 * 1024 } });
    }
  };
  res.once("close", () => { req.releaseUpload().catch(() => {}); });
  try {
    const active = await Video.countDocuments({ providerId: user._id, processingStatus: { $in: ["uploaded", "queued", "processing"] }, status: { $ne: "deleting" } });
    const [usage] = await Video.aggregate([
      { $match: { providerId: user._id } },
      { $group: { _id: null, bytes: { $sum: "$sourceBytes" } } },
    ]);
    const maxFile = 250 * 1024 * 1024;
    const quota = Number(process.env.UPLOAD_STORAGE_QUOTA_BYTES || 10 * 1024 ** 3);
    const daily = Number(process.env.UPLOAD_DAILY_QUOTA_BYTES || 1024 ** 3);
    if (active >= 2 || (usage?.bytes || 0) + maxFile > quota || maxFile > daily) {
      await req.releaseUpload();
      res.setHeader("Retry-After", "60");
      return fail(res, 429, "UPLOAD_QUOTA", "Upload quota reached");
    }
    // This ledger survives video deletion, so upload/delete loops cannot reset daily use.
    const reset = (Math.floor(Date.now() / 86400000) + 1) * 86400000;
    const bucketId = `upload-bytes:${user._id}:${reset}`;
    try {
      await RateBucket.findOneAndUpdate({ _id: bucketId, count: { $lte: daily - maxFile } }, { $inc: { count: maxFile }, $setOnInsert: { expiresAt: new Date(reset) } }, { upsert: true, returnDocument: "after" });
      dailyReservation = bucketId;
    } catch (err) {
      if (err.code !== 11000) throw err;
      await req.releaseUpload();
      res.setHeader("Retry-After", String(Math.ceil((reset - Date.now()) / 1000)));
      return fail(res, 429, "UPLOAD_DAILY_QUOTA", "Daily upload quota reached");
    }
    next();
  } catch (err) { await req.releaseUpload(); next(err); }
}
