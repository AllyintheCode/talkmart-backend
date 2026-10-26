import Video from "../models/Video.js";
import User from "../models/User.js";
import AuditEvent from "../models/AuditEvent.js";
import { delCachePattern } from "../config/redis.js";

export const publicVideoFilter = (prefix = "") => ({
  [`${prefix}status`]: "active", [`${prefix}processingStatus`]: "ready",
  [`${prefix}moderationStatus`]: "approved", [`${prefix}videoUrl`]: { $type: "string", $ne: "" },
  [`${prefix}visibility`]: { $ne: "hidden" },
});
export const publicOwnerFilter = (prefix = "provider.") => ({
  [`${prefix}isBlocked`]: { $ne: true }, [`${prefix}accountStatus`]: { $ne: "deleting" },
  [`${prefix}emailVerified`]: true,
});
export function canPublishVideo(video, owner) {
  return Boolean(video && video.processingStatus === "ready" && video.videoUrl &&
    video.moderationStatus === "approved" && video.status !== "deleting" &&
    video.visibility !== "hidden" && owner && !owner.isBlocked && owner.emailVerified && owner.accountStatus !== "deleting");
}
export async function invalidateVideoCache() {
  await Promise.all([delCachePattern("feed:*"), delCachePattern("categories:top:*")]);
}
export async function publishIfEligible(videoId) {
  const video = await Video.findById(videoId);
  if (!video) return null;
  const owner = await User.findById(video.providerId).select("isBlocked accountStatus emailVerified");
  const status = canPublishVideo(video, owner) ? "active" : "inactive";
  const updated = await Video.findOneAndUpdate({
    _id: videoId, status: { $ne: "deleting" }, decisionVersion: video.decisionVersion,
    processingStatus: video.processingStatus, moderationStatus: video.moderationStatus,
    visibility: video.visibility,
  }, { $set: { status } }, { returnDocument: "after", runValidators: true });
  await invalidateVideoCache();
  return updated;
}
export async function setAdminDecision(videoId, action, actorId, feedback = "") {
  if (!["approve", "reject"].includes(action)) throw Object.assign(new Error("Invalid action"), { status: 400, code: "INVALID_ACTION" });
  const video = await Video.findOneAndUpdate({ _id: videoId, status: { $ne: "deleting" } }, {
    $set: { moderationStatus: action === "approve" ? "approved" : "rejected", moderationSource: "admin", adminFeedback: feedback, status: "inactive" },
    $inc: { decisionVersion: 1 },
  }, { returnDocument: "after", runValidators: true });
  if (!video) return null;
  await AuditEvent.create({ actorId, targetId: videoId, action: `video_${action}`, reason: feedback });
  return await publishIfEligible(videoId) || video;
}
