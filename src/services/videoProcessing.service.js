import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import Video from "../models/Video.js";
import { generateThumbnail } from "./compress.service.js";
import { uploadFileToR2, uploadToR2, downloadFromR2, deleteFromR2, isPrivateMediaKey } from "./r2Upload.service.js";
import { prepareVideoMedia } from "./mediaPreparation.service.js";
import { validateUploadedVideo } from "./mediaProbe.service.js";
import { publishIfEligible } from "./videoState.service.js";
import { logger } from "../utils/logger.js";
import { observe } from "../utils/metrics.js";

export { canPublishVideo } from "./videoState.service.js";
export const LEASE_MS = 300000;
export const MAX_ATTEMPTS = 3;

// The video document is the durable queue. No destructive Redis pop or API fallback.
export async function acquireLease(videoId) {
  const now = new Date();
  return Video.findOneAndUpdate({
    ...(videoId ? { _id: videoId } : {}), status: { $ne: "deleting" },
    stagingKey: { $ne: "" }, attempt: { $lt: MAX_ATTEMPTS },
    $or: [
      { processingStatus: "queued", nextAttemptAt: { $lte: now } },
      { processingStatus: "processing", lockedUntil: { $lte: now } },
    ],
  }, { $set: {
    processingStatus: "processing", workerId: crypto.randomUUID(),
    lockedUntil: new Date(Date.now() + LEASE_MS), lastHeartbeatAt: now,
  }, $inc: { attempt: 1 } }, { sort: { createdAt: 1 }, returnDocument: "after", runValidators: true });
}
const leaseFilter = (job) => ({ _id: job._id, workerId: job.workerId, processingStatus: "processing", status: { $ne: "deleting" }, lockedUntil: { $gt: new Date() } });

export async function applyAiResult(job, ai, media) {
  if (!isPrivateMediaKey(media.privateVideoKey) || !isPrivateMediaKey(media.privateThumbnailKey)) throw new Error("PRIVATE_MEDIA_REQUIRED");
  // Commit media and the AI decision together, so a crash cannot leave ready/pending.
  const mediaFields = {
    privateVideoKey: media.privateVideoKey, privateThumbnailKey: media.privateThumbnailKey,
    videoUrl: "", publicId: "", thumbnail: "", thumbnailPublicId: "", status: "inactive",
    processingStatus: "ready", completedAt: new Date(), workerId: null, lockedUntil: null,
  };
  const retirement = { publicDeletionKeys: { $each: [job.publicId, job.thumbnailPublicId].filter(Boolean) } };
  const aiWrite = await Video.updateOne({
    ...leaseFilter(job), decisionVersion: job.decisionVersion,
    moderationSource: { $ne: "admin" },
  }, { $set: {
    ...mediaFields,
    moderationStatus: ai.finalStatus, moderationSource: "ai",
    aiFeedback: ai.aiData?.reasoning || "", aiConfidence: ai.aiData?.confidenceScore || 0,
  }, $addToSet: retirement }, { runValidators: true });
  if (!aiWrite.matchedCount) {
    // An admin override keeps its decision while this lease can still finish media.
    const mediaWrite = await Video.updateOne({ ...leaseFilter(job), $or: [
      { moderationSource: "admin" }, { decisionVersion: { $ne: job.decisionVersion } },
    ] }, { $set: mediaFields, $addToSet: retirement }, { runValidators: true });
    if (!mediaWrite.matchedCount) return false;
  }
  // Maintenance reconciles publication if the process exits after the commit.
  try { await publishIfEligible(job._id); } catch (err) { logger.warn("publication_retry", err); }
  return true;
}

export async function processVideoJob(job) {
  const started = Date.now();
  observe("queue_wait_ms", Math.max(0, started - new Date(job.createdAt).getTime()));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "talkmart-job-"));
  const input = path.join(directory, `input${job.originalExt}`);
  let compressed;
  let retained = false;
  const videoKey = `talkmart/private/videos/${job._id}/${job.workerId}.mp4`;
  const thumbKey = `talkmart/private/thumbnails/${job._id}/${job.workerId}.webp`;
  const beat = setInterval(() => {
    Video.updateOne(leaseFilter(job), { $set: { lockedUntil: new Date(Date.now() + LEASE_MS), lastHeartbeatAt: new Date() } })
      .catch((err) => logger.error("video_heartbeat_failed", err));
  }, 30000);
  try {
    // Record intended object names before writing storage, including crash recovery.
    const registered = await Video.updateOne(leaseFilter(job), { $addToSet: { mediaKeys: { $each: [videoKey, thumbKey, job.publicId, job.thumbnailPublicId].filter(Boolean) } } });
    if (!registered.matchedCount) return;
    let t = Date.now();
    await downloadFromR2(job.stagingKey, input);
    observe("r2_download_ms", Date.now() - t);
    await validateUploadedVideo(input);
    // Retain media for manual review and admin overrides, including AI rejection.
    const prepared = await prepareVideoMedia({ input, originalExt: job.originalExt, categoryName: job.categoryName, duration: job.duration });
    const ai = prepared.ai;
    compressed = prepared.compressed;
    if (!await Video.exists(leaseFilter(job))) return;
    t = Date.now();
    await uploadFileToR2(compressed.outputPath, "talkmart/private/videos", "video/mp4", ".mp4", videoKey);
    const thumb = await generateThumbnail(input, job.originalExt);
    await uploadToR2(thumb.buffer, "talkmart/private/thumbnails", thumb.mimetype, thumb.ext, thumbKey);
    observe("r2_upload_ms", Date.now() - t);
    retained = await applyAiResult(job, ai, { privateVideoKey: videoKey, privateThumbnailKey: thumbKey });
    if (retained) {
      // On failure the reference remains, so maintenance retries staging deletion.
      await deleteFromR2(job.stagingKey);
      await Video.updateOne({ _id: job._id, stagingKey: job.stagingKey }, { $set: { stagingKey: "" } });
    }
  } catch (err) {
    logger.error("video_job_failed", { videoId: job._id, attempt: job.attempt }, err);
    await Video.updateOne(leaseFilter(job), { $set: {
      processingStatus: job.attempt >= MAX_ATTEMPTS ? "failed" : "queued",
      workerId: null, lockedUntil: null, nextAttemptAt: new Date(Date.now() + 10000 * 2 ** job.attempt),
    } }, { runValidators: true });
  } finally {
    clearInterval(beat);
    compressed?.cleanup();
    await fs.rm(directory, { recursive: true, force: true });
    if (!retained) {
      // A timed-out DB response may still have committed. Never delete its media.
      try {
        const referenced = await Video.exists({ _id: job._id, $or: [{ privateVideoKey: videoKey }, { privateThumbnailKey: thumbKey }] });
        if (!referenced) await Promise.allSettled([deleteFromR2(videoKey), deleteFromR2(thumbKey)]);
      } catch (err) { logger.warn("media_compensation_deferred", err); }
    }
    observe("video_job_ms", Date.now() - started);
  }
}
export async function recoverStuckVideos() {
  // Active leases are never touched. Exhausted expired jobs form the dead-letter list.
  await Video.updateMany({ processingStatus: "processing", lockedUntil: { $lte: new Date() }, attempt: { $gte: MAX_ATTEMPTS }, status: { $ne: "deleting" } },
    { $set: { processingStatus: "failed", workerId: null, lockedUntil: null } });
}
export async function getQueueStats() {
  const [queued, running, failed] = await Promise.all([
    Video.countDocuments({ processingStatus: "queued" }),
    Video.countDocuments({ processingStatus: "processing" }),
    Video.countDocuments({ processingStatus: "failed" }),
  ]);
  return { queued, running, failed };
}
