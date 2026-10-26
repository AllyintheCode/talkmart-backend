import mongoose from "mongoose";
import Video from "../models/Video.js";
import User from "../models/User.js";
import { VideoLike, VideoSave } from "../models/VideoInteraction.js";
import { publicVideoFilter, canPublishVideo } from "./videoState.service.js";
export async function setInteraction(videoId, userId, kind, desired) {
  const Model = kind === "like" ? VideoLike : VideoSave;
  const field = kind === "like" ? "likeCount" : "saveCount";
  const session = await mongoose.startSession();
  try {
    let result;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await session.withTransaction(async () => {
          const video = await Video.findOne({ _id: videoId, ...publicVideoFilter() }).session(session);
          const owner = video && await User.findById(video.providerId).session(session);
          if (!canPublishVideo(video, owner)) throw Object.assign(new Error("Video unavailable"), { status: 404, code: "NOT_FOUND" });
          if (String(video.providerId) === String(userId)) throw Object.assign(new Error("Cannot engage with own video"), { status: 403, code: "OWN_VIDEO" });
          if (desired) await Model.updateOne({ videoId, userId }, { $setOnInsert: { videoId, userId } }, { upsert: true, session });
          else await Model.deleteOne({ videoId, userId }, { session });
          const count = await Model.countDocuments({ videoId }).session(session);
          const update = await Video.updateOne({ _id: videoId, ...publicVideoFilter() }, { $set: { [field]: count } }, { session });
          if (!update.matchedCount) throw new Error("VIDEO_STATE_CHANGED");
          result = { enabled: desired, count };
        });
        return result;
      } catch (err) { if (err.code !== 11000 || attempt === 2) throw err; }
    }
  } finally { await session.endSession(); }
}
