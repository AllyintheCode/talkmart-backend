import ViewWindow from "../models/ViewWindow.js";
import Report from "../models/Report.js";
import Video from "../models/Video.js";
import { VideoLike, VideoSave, VideoView } from "../models/VideoInteraction.js";
import { deleteFromR2 } from "./r2Upload.service.js";
import { delCachePattern } from "../config/redis.js";

export async function markVideoDeleting(videoId) {
  return Video.findOneAndUpdate(
    { _id: videoId, status: { $ne: "deleting" } },
    {
      $set: {
        status: "deleting",
        processingStatus: "deleting",
        workerId: null,
        lockedUntil: null,
      },
      $inc: { decisionVersion: 1 },
    },
    { returnDocument: "after" },
  );
}

export async function cleanupVideoResources(video) {
  if (!video) return;
  await Promise.all([
    deleteFromR2(video.publicId),
    deleteFromR2(video.thumbnailPublicId),
    deleteFromR2(video.stagingKey),
    deleteFromR2(video.privateVideoKey),
    deleteFromR2(video.privateThumbnailKey),
    ...(video.mediaKeys || []).map((key) => deleteFromR2(key)),
    ...(video.publicDeletionKeys || []).map(key => deleteFromR2(key)),
  ]);

  if (video.thumbnail && !video.thumbnailPublicId) {
    try {
      const thumbUrl = new URL(video.thumbnail);
      await deleteFromR2(thumbUrl.pathname.replace(/^\//, ""));
    } catch (err) { throw err; }
  }

  await Promise.all([
    VideoLike.deleteMany({ videoId: video._id }),
    VideoSave.deleteMany({ videoId: video._id }),
    VideoView.deleteMany({ videoId: video._id }),
    ViewWindow.deleteMany({ videoId: video._id }),
    Report.updateMany({ videoId: video._id }, { $set: { videoId: null } }),
  ]);

  await Video.deleteOne({ _id: video._id, status: "deleting" });
  await delCachePattern("feed:*");
  await delCachePattern("categories:top:*");
}

export async function deleteVideoCompletely(videoId, ownerFilter = {}) {
  const existing = await Video.findOne({ _id: videoId, ...ownerFilter });
  if (!existing) return null;
  await markVideoDeleting(videoId);
  await delCachePattern("feed:*");
  await delCachePattern("categories:top:*");
  return existing;
}
