import crypto from "node:crypto";
import Video from "../models/Video.js";
import User from "../models/User.js";
import { canPreparePublication } from "./videoPolicy.service.js";
import { copyMediaObject, deleteFromR2, privatePreviewUrl, publicMediaUrl } from "./r2Upload.service.js";
import { logger } from "../utils/logger.js";

const idleMediaLease = () => ({ $or: [{ mediaPublicationId: null }, { mediaPublicationUntil: { $lte: new Date() } }] });
const versionFilter = video => ({ _id: video._id, decisionVersion: video.decisionVersion, status: { $ne: "deleting" },
  processingStatus: video.processingStatus, moderationStatus: video.moderationStatus, visibility: video.visibility });
const keyFromUrl = (value, prefix) => {
  try { const key = decodeURIComponent(new URL(value).pathname).replace(/^\/+/, ""); return key.startsWith(prefix) ? key : ""; }
  catch { return ""; }
};
const publishedKeys = video => ({
  video: video.publicId || keyFromUrl(video.videoUrl, "talkmart/videos/"),
  thumbnail: video.thumbnailPublicId || keyFromUrl(video.thumbnail, "talkmart/thumbnails/"),
});
async function compensate(keys) {
  for (const key of keys.filter(Boolean)) {
    // A DB response can be lost after commit; storage may only be removed after a successful reference check.
    const referenced = await Video.exists({ $or: [{ publicId: key }, { thumbnailPublicId: key }, { privateVideoKey: key }, { privateThumbnailKey: key }] });
    if (!referenced) await deleteFromR2(key);
  }
}

async function drainPublicDeletion(video) {
  const pending = video.publicDeletionKeys || [];
  if (!pending.length) return video;
  await compensate(pending);
  await Video.updateOne({ _id: video._id }, { $pull: { publicDeletionKeys: { $in: pending } } });
  return Video.findById(video._id);
}

export async function reconcileVideoMedia(videoId) {
  let video = await Video.findById(videoId);
  if (!video || video.status === "deleting") return video;
  video = await drainPublicDeletion(video);
  if (!video || video.status === "deleting") return video;
  const owner = await User.findById(video.providerId).select("emailVerified isBlocked accountStatus").lean();
  const eligible = canPreparePublication(video, owner);
  const old = publishedKeys(video);
  if (eligible && video.videoUrl && !video.mediaRevocationPending) {
    return Video.findOneAndUpdate({ ...versionFilter(video), ...idleMediaLease() }, { $set: { status: "active" } }, { returnDocument: "after" });
  }
  if (!eligible && !old.video && !old.thumbnail) {
    return Video.findOneAndUpdate(versionFilter(video), { $set: { status: "inactive", mediaRevocationPending: false } }, { returnDocument: "after" });
  }
  // Already-public legacy content can be reapproved while quarantine is still waiting on storage.
  if (eligible && video.videoUrl && video.mediaRevocationPending) {
    return Video.findOneAndUpdate({ ...versionFilter(video), ...idleMediaLease() },
      { $set: { status: "active", mediaRevocationPending: false } }, { returnDocument: "after" });
  }
  const id = crypto.randomUUID();
  const keys = eligible ? {
    video: `talkmart/videos/${video._id}/${id}.mp4`, thumbnail: video.privateThumbnailKey ? `talkmart/thumbnails/${video._id}/${id}.webp` : "",
  } : {
    video: video.privateVideoKey || (old.video ? `talkmart/private/videos/${video._id}/${id}.mp4` : ""),
    thumbnail: video.privateThumbnailKey || (old.thumbnail ? `talkmart/private/thumbnails/${video._id}/${id}.webp` : ""),
  };
  const allocated = Object.values(keys).filter(Boolean);
  const lease = await Video.findOneAndUpdate({ ...versionFilter(video), ...idleMediaLease() }, {
    $set: { mediaPublicationId: id, mediaPublicationUntil: new Date(Date.now() + 300000), status: "inactive" },
    $addToSet: { mediaKeys: { $each: [...allocated, old.video, old.thumbnail].filter(Boolean) } },
  }, { returnDocument: "after" });
  if (!lease) return Video.findById(videoId);
  const fence = () => ({ ...versionFilter(lease), mediaPublicationId: id, mediaPublicationUntil: { $gt: new Date() } });
  let committed = false;
  try {
    if (eligible) {
      if (!video.privateVideoKey) throw new Error("PRIVATE_MEDIA_INCOMPLETE");
      if (!await Video.exists(fence())) return Video.findById(videoId);
      await copyMediaObject(video.privateVideoKey, keys.video, "video/mp4");
      if (!await Video.exists(fence())) return Video.findById(videoId);
      if (keys.thumbnail) await copyMediaObject(video.privateThumbnailKey, keys.thumbnail, "image/webp");
      const currentOwner = await User.findById(video.providerId).select("emailVerified isBlocked accountStatus").lean();
      if (!canPreparePublication(video, currentOwner)) return Video.findById(videoId);
      const result = await Video.findOneAndUpdate(fence(), { $set: {
        videoUrl: publicMediaUrl(keys.video), publicId: keys.video, thumbnail: keys.thumbnail ? publicMediaUrl(keys.thumbnail) : "", thumbnailPublicId: keys.thumbnail,
        status: "active", mediaPublicationId: null, mediaPublicationUntil: null, mediaRevocationPending: false,
      } }, { returnDocument: "after", runValidators: true });
      committed = Boolean(result);
      return result || await Video.findById(videoId);
    }
    if (old.video && !video.privateVideoKey) await copyMediaObject(old.video, keys.video, "video/mp4");
    if (old.thumbnail && !video.privateThumbnailKey) {
      try { await copyMediaObject(old.thumbnail, keys.thumbnail, "image/webp"); }
      catch (error) {
        if (["NoSuchKey", "NotFound"].includes(error.code || error.name) || error.$metadata?.httpStatusCode === 404) keys.thumbnail = "";
        else throw error;
      }
    }
    const result = await Video.findOneAndUpdate(fence(), { $set: {
      privateVideoKey: keys.video, privateThumbnailKey: keys.thumbnail, videoUrl: "", publicId: "", thumbnail: "", thumbnailPublicId: "",
      status: "inactive", mediaPublicationId: null, mediaPublicationUntil: null, mediaRevocationPending: true,
    }, $addToSet: { publicDeletionKeys: { $each: [old.video, old.thumbnail].filter(Boolean) } } }, { returnDocument: "after", runValidators: true });
    committed = Boolean(result);
    if (committed) {
      await drainPublicDeletion(result);
      await Video.updateOne({ _id: videoId, decisionVersion: result.decisionVersion, publicDeletionKeys: { $size: 0 }, publicId: "" }, { $set: { mediaRevocationPending: false } });
    }
    return Video.findById(videoId);
  } finally {
    try {
      if (!committed) await compensate(allocated);
    } catch (error) { logger.warn("media_compensation_retry", error); }
    await Video.updateOne({ _id: videoId, mediaPublicationId: id }, { $set: { mediaPublicationId: null, mediaPublicationUntil: null } });
  }
}

export async function videoForViewer(input, viewer) {
  const video = input.toObject ? input.toObject() : { ...input };
  const ownerId = String(video.providerId?._id || video.providerId);
  if (!viewer || (viewer.role !== "admin" && String(viewer._id) !== ownerId)) throw new Error("PRIVATE_MEDIA_FORBIDDEN");
  if (video.status !== "active" || video.moderationStatus !== "approved" || video.visibility === "hidden") {
    video.videoUrl = ""; video.thumbnail = "";
    if (video.privateVideoKey) video.videoUrl = await privatePreviewUrl(video.privateVideoKey);
    if (video.privateThumbnailKey) video.thumbnail = await privatePreviewUrl(video.privateThumbnailKey);
    if (video.videoUrl || video.thumbnail) video.mediaUrlExpiresAt = new Date(Date.now() + 600000).toISOString();
  }
  for (const internal of ["privateVideoKey", "privateThumbnailKey", "mediaPublicationId", "mediaPublicationUntil", "publicDeletionKeys"]) delete video[internal];
  return video;
}
