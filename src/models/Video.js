import mongoose from "mongoose";

const VideoSchema = new mongoose.Schema(
  {
    providerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    categoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      required: true,
    },

    title: {
      type: String,
      trim: true,
      default: "",
    },

    description: {
      type: String,
      trim: true,
      required: true,
    },

    price: {
      type: Number,
      required: true,
      min: 0,
    },

    videoUrl: {
      type: String,
      default: "",
    },

    publicId: {
      type: String,
      default: "",
    },

    thumbnail: {
      type: String,
      default: "",
    },

    duration: {
      type: Number, // saniyə ilə
      default: 0,
    },

    likeCount: {
      type: Number,
      default: 0,
    },

    viewCount: {
      type: Number,
      default: 0,
    },

    saveCount: {
      type: Number,
      default: 0,
    },

    status: {
      type: String,
      enum: ["active", "inactive", "deleting"],
      default: "inactive", // Varsayılan olaraq aktiv deyil, təsdiqlənməlidir
    },

    moderationStatus: {
      type: String,
      enum: ["pending", "approved", "rejected", "review"],
      default: "pending",
    },

    // Moderasiya qərarının mənbəyi (AI və ya Admin) (TM-011)
    moderationSource: {
      type: String,
      enum: ["ai", "admin", null],
      default: null,
    },

    // Admin vs AI yarışlarını idarə edən versiya nömrəsi (TM-011)
    decisionVersion: {
      type: Number,
      default: 1,
    },

    // Video emal statusu (TM-012)
    processingStatus: {
      type: String,
      enum: ["uploaded", "queued", "processing", "ready", "failed", "deleting"],
      default: "queued",
    },

    // Worker lease / kilidlənmə vaxtı (TM-010)
    lockedUntil: {
      type: Date,
      default: null,
    },

    workerId: {
      type: String,
      default: null,
    },

    lastHeartbeatAt: {
      type: Date,
      default: null,
    },

    attempt: {
      type: Number,
      default: 0,
    },

    stagingKey: {
      type: String,
      default: "",
    },

    thumbnailPublicId: {
      type: String,
      default: "",
    },

    originalExt: {
      type: String,
      default: ".mp4",
    },
    categoryName: { type: String, default: "" },
    sourceBytes: { type: Number, default: 0, min: 0 },
    uploadId: { type: String, default: null },
    visibility: { type: String, enum: ["public", "hidden"], default: "public" },
    nextAttemptAt: { type: Date, default: Date.now },
    mediaKeys: { type: [String], default: [] },
    completedAt: { type: Date, default: null },
    schemaVersion: { type: Number, default: 2 },

    aiFeedback: {
      type: String,
      default: "",
    },

    aiConfidence: {
      type: Number,
      default: 0, // 0-100% arası
    },

    adminFeedback: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

// =============================================
// PERFORMANCE İNDEKSLƏRİ
// =============================================

// Feed: aktiv videolar → ən yeni (status + createdAt)
VideoSchema.index({ status: 1, createdAt: -1 });

// Explore: kateqoriya + status + tarix filteri
VideoSchema.index({ status: 1, categoryId: 1, createdAt: -1 });

// Qiymət aralığı filteri (minPrice/maxPrice)
VideoSchema.index({ status: 1, price: 1 });

// Trending sıralama
VideoSchema.index({ status: 1, viewCount: -1, likeCount: -1 });

// Provider-in öz videoları
VideoSchema.index({ providerId: 1, createdAt: -1 });

// Ad/açıqlama üzrə text axtarışı
VideoSchema.index({ title: "text", description: "text" });

// Moderation filteri
VideoSchema.index({ moderationStatus: 1, createdAt: -1 });

// Worker queue & recovery index (TM-010)
VideoSchema.index({ processingStatus: 1, lockedUntil: 1 });
VideoSchema.index({ processingStatus: 1, nextAttemptAt: 1, createdAt: 1 });
VideoSchema.index({ providerId: 1, uploadId: 1 }, { unique: true, partialFilterExpression: { uploadId: { $type: "string" } } });

export default mongoose.models.Video || mongoose.model("Video", VideoSchema);
