export const publicVideoFilter = (prefix = "") => ({
  [`${prefix}status`]: "active", [`${prefix}processingStatus`]: "ready",
  [`${prefix}moderationStatus`]: "approved", [`${prefix}videoUrl`]: { $type: "string", $ne: "" },
  [`${prefix}visibility`]: { $ne: "hidden" },
});
export const publicOwnerFilter = (prefix = "provider.") => ({
  [`${prefix}isBlocked`]: { $ne: true }, [`${prefix}accountStatus`]: { $ne: "deleting" },
  [`${prefix}emailVerified`]: true,
});
export function canPreparePublication(video, owner) {
  return Boolean(video && video.processingStatus === "ready" && (video.videoUrl || video.privateVideoKey) &&
    video.moderationStatus === "approved" && video.status !== "deleting" && video.visibility !== "hidden" &&
    owner && !owner.isBlocked && owner.emailVerified && owner.accountStatus !== "deleting");
}
export function canPublishVideo(video, owner) {
  return Boolean(video?.videoUrl && canPreparePublication(video, owner));
}
