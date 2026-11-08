import Video from "../models/Video.js";
import AuditEvent from "../models/AuditEvent.js";
import { delCachePattern } from "../config/redis.js";
import { reconcileVideoMedia } from "./videoMedia.service.js";
import { logger } from "../utils/logger.js";
export { publicVideoFilter, publicOwnerFilter, canPublishVideo, canPreparePublication } from "./videoPolicy.service.js";
export async function invalidateVideoCache() {
  await Promise.all([delCachePattern("feed:*"), delCachePattern("categories:top:*")]);
}
export async function publishIfEligible(videoId) {
  try { return await reconcileVideoMedia(videoId) || await Video.findById(videoId); }
  finally { await invalidateVideoCache(); }
}
export async function setAdminDecision(videoId, action, actorId, feedback = "") {
  if (!["approve", "reject"].includes(action)) throw Object.assign(new Error("Invalid action"), { status: 400, code: "INVALID_ACTION" });
  const video = await Video.findOneAndUpdate({ _id: videoId, status: { $ne: "deleting" } }, {
    $set: { moderationStatus: action === "approve" ? "approved" : "rejected", moderationSource: "admin", adminFeedback: feedback,
      status: "inactive", mediaRevocationPending: action === "reject" },
    $inc: { decisionVersion: 1 },
  }, { returnDocument: "after", runValidators: true });
  if (!video) return null;
  await AuditEvent.create({ actorId, targetId: videoId, action: `video_${action}`, reason: feedback });
  try { return await publishIfEligible(videoId) || video; }
  catch (error) { logger.warn("admin_media_reconciliation_retry", error); return await Video.findById(videoId); }
}
