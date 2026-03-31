import mongoose from "mongoose";

// Like — hər user hər videonu yalnız 1 dəfə like edə bilər
const VideoLikeSchema = new mongoose.Schema(
  {
    videoId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Video",
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);
VideoLikeSchema.index({ videoId: 1, userId: 1 }, { unique: true });

// Save (kayd) — hər user hər videonu yalnız 1 dəfə saxlaya bilər
const VideoSaveSchema = new mongoose.Schema(
  {
    videoId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Video",
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);
VideoSaveSchema.index({ videoId: 1, userId: 1 }, { unique: true });

// View — eyni user eyni videonu 24 saatda yalnız 1 dəfə sayılır
const VideoViewSchema = new mongoose.Schema(
  {
    videoId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Video",
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    lastViewedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);
VideoViewSchema.index({ videoId: 1, userId: 1 }, { unique: true });

export const VideoLike =
  mongoose.models.VideoLike || mongoose.model("VideoLike", VideoLikeSchema);

export const VideoSave =
  mongoose.models.VideoSave || mongoose.model("VideoSave", VideoSaveSchema);

export const VideoView =
  mongoose.models.VideoView || mongoose.model("VideoView", VideoViewSchema);
