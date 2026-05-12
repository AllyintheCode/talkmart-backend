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
      required: true,
    },

    publicId: {
      type: String,
      required: true,
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
      enum: ["active", "inactive"],
      default: "active",
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

export default mongoose.models.Video || mongoose.model("Video", VideoSchema);
