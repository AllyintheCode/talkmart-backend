import { canPublishVideo } from "./videoState.service.js";
export function legacyThumbnailKey(video) {
  if (video.thumbnailPublicId) return video.thumbnailPublicId;
  try {
    const key = decodeURIComponent(new URL(video.thumbnail).pathname).replace(/^\/+/, "");
    return key.startsWith("talkmart/thumbnails/") ? key : "";
  } catch { return ""; }
}
export function videoV2Fields(video, owner) {
  const allowedProcessing = ["uploaded", "queued", "processing", "ready", "failed", "deleting"];
  const processingStatus = allowedProcessing.includes(video.processingStatus) ? video.processingStatus : video.videoUrl ? "ready" : "failed";
  const fields = {
    schemaVersion: 2,
    processingStatus,
    moderationStatus: ["pending", "approved", "rejected", "review"].includes(video.moderationStatus) ? video.moderationStatus : "review",
    moderationSource: ["ai", "admin"].includes(video.moderationSource) ? video.moderationSource : null,
    decisionVersion: Number.isInteger(video.decisionVersion) && video.decisionVersion > 0 ? video.decisionVersion : 1,
    visibility: video.visibility || (video.status === "inactive" && video.moderationStatus === "approved" ? "hidden" : "public"),
    attempt: Number.isInteger(video.attempt) ? video.attempt : 0,
    workerId: null, lockedUntil: null, nextAttemptAt: new Date(),
    mediaKeys: video.mediaKeys || [], stagingKey: video.stagingKey || "",
    thumbnailPublicId: legacyThumbnailKey(video),
    categoryName: video.categoryName || "", originalExt: video.originalExt || ".mp4",
    sourceBytes: video.sourceBytes || 0,
  };
  if (["queued", "processing", "uploaded"].includes(fields.processingStatus)) {
    // Local-only legacy jobs cannot be recovered without their source; never invent it.
    fields.processingStatus = fields.stagingKey ? "queued" : "failed";
  }
  if (fields.processingStatus === "failed" && fields.moderationSource !== "admin") fields.moderationStatus = "review";
  fields.status = video.status === "deleting" ? "deleting" : canPublishVideo({ ...video, ...fields }, owner) ? "active" : "inactive";
  return fields;
}
