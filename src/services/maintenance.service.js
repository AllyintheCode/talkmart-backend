import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import mongoose from "mongoose";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import r2 from "../config/r2.js";
import User from "../models/User.js";
import Video from "../models/Video.js";
import { VideoLike, VideoSave } from "../models/VideoInteraction.js";
import { cleanupVideoResources } from "./videoCleanup.service.js";
import { cleanupDeletedAccount } from "./accountCleanup.service.js";
import { deleteFromR2, bucketFor } from "./r2Upload.service.js";
import { recoverStuckVideos } from "./videoProcessing.service.js";
import { observe } from "../utils/metrics.js";
import { logger } from "../utils/logger.js";
import { publishIfEligible } from "./videoState.service.js";

const cursors = new Map();
let lastVideoId;
let lastMediaVideoId;
export async function reconcileCounters() {
  const videos = await Video.find({ ...(lastVideoId ? { _id: { $gt: lastVideoId } } : {}), status: { $ne: "deleting" } }).sort({ _id: 1 }).limit(25).select("_id");
  if (!videos.length) lastVideoId = null;
  for (const video of videos) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const likeCount = await VideoLike.countDocuments({ videoId: video._id }).session(session);
        const saveCount = await VideoSave.countDocuments({ videoId: video._id }).session(session);
        await Video.updateOne({ _id: video._id, status: { $ne: "deleting" } }, { $set: { likeCount, saveCount } }, { session });
      });
      lastVideoId = video._id;
    } finally { await session.endSession(); }
  }
}
export async function reconcileOrphanObjects() {
  for (const prefix of ["talkmart/staging/", "talkmart/private/videos/", "talkmart/private/thumbnails/", "talkmart/videos/", "talkmart/thumbnails/"]) {
    const bucket = bucketFor(prefix);
    const result = await r2.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 100, ContinuationToken: cursors.get(prefix) }));
    cursors.set(prefix, result.NextContinuationToken);
    for (const object of result.Contents || []) {
      if (!object.LastModified || Date.now() - object.LastModified.getTime() < 86400000) continue;
      // Legacy rows stored only a public URL. Retain them until migration fills keys.
      const publicBase = process.env.R2_PUBLIC_URL || "";
      const legacyUrls = [...new Set([
        `${publicBase.replace(/\/+$/, "")}/${object.Key}`,
        `${publicBase}/${object.Key}`,
      ])];
      const referenced = await Video.exists({ $or: [
        { publicId: object.Key }, { thumbnailPublicId: object.Key },
        { stagingKey: object.Key }, { mediaKeys: object.Key },
        { privateVideoKey: object.Key }, { privateThumbnailKey: object.Key },
        { thumbnail: { $in: legacyUrls } }, { videoUrl: { $in: legacyUrls } },
      ] });
      if (!referenced) { await deleteFromR2(object.Key); observe("orphan_objects_removed", 1); }
    }
  }
}
export async function cleanupTempFiles() {
  const root = path.resolve(os.tmpdir());
  for (const name of await fs.readdir(root)) {
    if (!/^(talkmart-(job|frames|recheck)-|upload_[a-f\d-]{36}\.|(?:input|output|thumb_in|thumb_out|dur_in|kf)_[a-f\d-]{36}\.)/.test(name)) continue;
    const target = path.resolve(root, name);
    if (path.dirname(target) !== root) continue;
    const stat = await fs.lstat(target);
    if (!stat.isSymbolicLink() && Date.now() - stat.mtimeMs > 86400000) await fs.rm(target, { recursive: stat.isDirectory(), force: true });
  }
}
export async function runMaintenance() {
  await recoverStuckVideos();
  await Video.updateMany({ processingStatus: "uploaded", createdAt: { $lt: new Date(Date.now() - 3600000) } }, { $set: { status: "deleting", processingStatus: "deleting" } });
  for (const user of await User.find({ accountStatus: "deleting" }).limit(10)) {
    try { await cleanupDeletedAccount(user); } catch (err) { logger.warn("account_cleanup_retry", err); }
  }
  for (const video of await Video.find({ status: "deleting" }).limit(25)) {
    try { await cleanupVideoResources(video); } catch (err) { logger.warn("video_cleanup_retry", err); }
  }
  for (const video of await Video.find({ processingStatus: { $in: ["ready", "failed"] }, $and: [
    { $or: [{ mediaPublicationId: null }, { mediaPublicationUntil: { $lte: new Date() } }] },
    { $or: [{ stagingKey: { $ne: "" }, processingStatus: "ready" }, { $expr: { $gt: [{ $size: { $setDifference: [{ $ifNull: ["$mediaKeys", []] }, ["$publicId", "$thumbnailPublicId", "$privateVideoKey", "$privateThumbnailKey"]] } }, 0] } }] },
  ] }).limit(25)) {
    try {
      const retainedKeys = [video.publicId, video.thumbnailPublicId, video.privateVideoKey, video.privateThumbnailKey];
      const unused = (video.mediaKeys || []).filter(key => !retainedKeys.includes(key));
      for (const key of unused) await deleteFromR2(key);
      if (video.processingStatus === "ready" && video.stagingKey) await deleteFromR2(video.stagingKey);
      await Video.updateOne({ _id: video._id, processingStatus: video.processingStatus }, { $pull: { mediaKeys: { $in: unused } }, ...(video.processingStatus === "ready" ? { $set: { stagingKey: "" } } : {}) });
    } catch (err) { logger.warn("media_cleanup_retry", err); }
  }
  const urgent = await Video.find({ processingStatus: "ready", status: { $ne: "deleting" }, $or: [
    { moderationStatus: "approved", status: "inactive", visibility: "public" }, { mediaRevocationPending: true }, { "publicDeletionKeys.0": { $exists: true } },
  ] }).limit(25).select("_id");
  const scan = await Video.find({ processingStatus: "ready", status: { $ne: "deleting" }, ...(lastMediaVideoId ? { _id: { $gt: lastMediaVideoId } } : {}) })
    .sort({ _id: 1 }).limit(25).select("_id");
  lastMediaVideoId = scan.at(-1)?._id || null;
  for (const video of [...new Map([...urgent, ...scan].map(item => [String(item._id), item])).values()]) {
    try { await publishIfEligible(video._id); }
    catch (error) { logger.warn("video_media_reconciliation_retry", { videoId: video._id }, error); }
  }
  await reconcileCounters();
}
