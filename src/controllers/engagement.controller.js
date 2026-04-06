import mongoose from "mongoose";
import Video from "../models/Video.js";
import {
  VideoLike,
  VideoSave,
  VideoView,
} from "../models/VideoInteraction.js";

// ==================== HELPER ====================

// ObjectId format yoxlanışı
const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

// ==================== LIKE / UNLIKE ====================

// POST /api/videos/:id/like  →  toggle like
export const toggleLike = async (req, res) => {
  try {
    const videoId = req.params.id;
    const userId = req.user._id;

    // ObjectId format yoxla
    if (!isValidObjectId(videoId)) {
      return res.status(400).json({ message: "Yanlış video ID formatı." });
    }

    const video = await Video.findById(videoId);
    if (!video) {
      return res.status(404).json({ message: "Video tapılmadı." });
    }

    // Öz videosunu like etmə qadağası
    if (video.providerId.toString() === userId.toString()) {
      return res.status(403).json({
        success: false,
        message: "Öz videonuzu like edə bilməzsiniz.",
      });
    }

    const existing = await VideoLike.findOne({ videoId, userId });

    if (existing) {
      // Artıq like edib → unlike et (atomik $inc)
      await existing.deleteOne();
      await Video.findByIdAndUpdate(videoId, {
        $inc: { likeCount: -1 },
      });

      // Güncel sayı al
      const updated = await Video.findById(videoId).select("likeCount");

      return res.json({
        success: true,
        liked: false,
        likeCount: Math.max(0, updated.likeCount),
        message: "Like silindi.",
      });
    }

    // Yeni like (atomik $inc)
    await VideoLike.create({ videoId, userId });
    const updated = await Video.findByIdAndUpdate(
      videoId,
      { $inc: { likeCount: 1 } },
      { new: true }
    ).select("likeCount");

    return res.json({
      success: true,
      liked: true,
      likeCount: updated.likeCount,
      message: "Like edildi.",
    });
  } catch (err) {
    // Duplicate key (race condition halları üçün)
    if (err.code === 11000) {
      return res.status(409).json({ message: "Artıq like edilib." });
    }
    console.error("toggleLike error:", err);
    return res.status(500).json({ message: "Server xətası." });
  }
};

// ==================== SAVE / UNSAVE ====================

// POST /api/videos/:id/save  →  toggle save (kayd)
export const toggleSave = async (req, res) => {
  try {
    const videoId = req.params.id;
    const userId = req.user._id;

    // ObjectId format yoxla
    if (!isValidObjectId(videoId)) {
      return res.status(400).json({ message: "Yanlış video ID formatı." });
    }

    const video = await Video.findById(videoId);
    if (!video) {
      return res.status(404).json({ message: "Video tapılmadı." });
    }

    // Öz videosunu save etmə qadağası
    if (video.providerId.toString() === userId.toString()) {
      return res.status(403).json({
        success: false,
        message: "Öz videonuzu kayd edə bilməzsiniz.",
      });
    }

    const existing = await VideoSave.findOne({ videoId, userId });

    if (existing) {
      // Artıq saxlayıb → kayd-dan çıxar (atomik $inc)
      await existing.deleteOne();
      await Video.findByIdAndUpdate(videoId, {
        $inc: { saveCount: -1 },
      });

      const updated = await Video.findById(videoId).select("saveCount");

      return res.json({
        success: true,
        saved: false,
        saveCount: Math.max(0, updated.saveCount),
        message: "Kayd silindi.",
      });
    }

    // Yeni kayd (atomik $inc)
    await VideoSave.create({ videoId, userId });
    const updated = await Video.findByIdAndUpdate(
      videoId,
      { $inc: { saveCount: 1 } },
      { new: true }
    ).select("saveCount");

    return res.json({
      success: true,
      saved: true,
      saveCount: updated.saveCount,
      message: "Video kayd edildi.",
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: "Artıq kayd edilib." });
    }
    console.error("toggleSave error:", err);
    return res.status(500).json({ message: "Server xətası." });
  }
};

// ==================== VIEW (24-saat rate-limit) ====================

// POST /api/videos/:id/view  →  görüntülənmə qeyd et
// Guest (req.user = null) halda IP äsasında anonim say edirik
export const recordView = async (req, res) => {
  try {
    const videoId = req.params.id;

    if (!isValidObjectId(videoId)) {
      return res.status(400).json({ message: "Yanlış video ID formatı." });
    }

    const video = await Video.findById(videoId);
    if (!video) {
      return res.status(404).json({ message: "Video tapılmadı." });
    }

    // ====== GUEST (login olmamış) ======
    // IP äsasında anonim view — sadecə say, hesdə qeyd yoxdur
    if (!req.user || req.user.role === "guest") {
      const updated = await Video.findByIdAndUpdate(
        videoId,
        { $inc: { viewCount: 1 } },
        { new: true }
      ).select("viewCount");

      return res.json({
        success: true,
        counted: true,
        viewCount: updated.viewCount,
        message: "Görüntülənmə qeyd edildi.",
      });
    }

    // ====== LOGIN OLMUŞ İSTIFADƎÇİ ======
    const userId = req.user._id;

    // Öz videosunu görüntülənmə kimi sayma
    if (video.providerId.toString() === userId.toString()) {
      return res.json({
        success: true,
        counted: false,
        viewCount: video.viewCount,
        message: "Öz videonuza görüntülənmə sayılmır.",
      });
    }

    const existing = await VideoView.findOne({ videoId, userId });

    if (existing) {
      const hoursSinceLast =
        (Date.now() - existing.lastViewedAt.getTime()) / (1000 * 60 * 60);

      if (hoursSinceLast < 24) {
        return res.json({
          success: true,
          counted: false,
          viewCount: video.viewCount,
          message: "Bu video artıq görüntülənib (24 saat gözləyin).",
        });
      }

      existing.lastViewedAt = new Date();
      await existing.save();
    } else {
      await VideoView.create({ videoId, userId, lastViewedAt: new Date() });
    }

    const updated = await Video.findByIdAndUpdate(
      videoId,
      { $inc: { viewCount: 1 } },
      { new: true }
    ).select("viewCount");

    return res.json({
      success: true,
      counted: true,
      viewCount: updated.viewCount,
      message: "Görüntülənmə qeyd edildi.",
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.json({ success: true, counted: false, message: "Artıq qeyd edilib." });
    }
    console.error("recordView error:", err);
    return res.status(500).json({ message: "Server xətası." });
  }
};

// ==================== GET ENGAGEMENT STATUS ====================

// GET /api/videos/:id/engagement  →  user üçün status + saylar
// Guest (req.user = null) halda: isLiked/isSaved = false qaytırılır
export const getEngagement = async (req, res) => {
  try {
    const videoId = req.params.id;

    if (!isValidObjectId(videoId)) {
      return res.status(400).json({ message: "Yanlış video ID formatı." });
    }

    const video = await Video.findById(videoId);
    if (!video) {
      return res.status(404).json({ message: "Video tapılmadı." });
    }

    // ====== GUEST ======
    // Sayları göstər, amma isLiked/isSaved = false (DB sorgusu yoxdur)
    if (!req.user || req.user.role === "guest") {
      return res.json({
        success: true,
        likeCount: video.likeCount,
        viewCount: video.viewCount,
        saveCount: video.saveCount,
        isLiked: false,
        isSaved: false,
        isGuest: true,
      });
    }

    // ====== LOGIN OLMUŞ İSTIFADƎÇİ ======
    const userId = req.user._id;
    const [liked, saved] = await Promise.all([
      VideoLike.exists({ videoId, userId }),
      VideoSave.exists({ videoId, userId }),
    ]);

    return res.json({
      success: true,
      likeCount: video.likeCount,
      viewCount: video.viewCount,
      saveCount: video.saveCount,
      isLiked: !!liked,
      isSaved: !!saved,
      isGuest: false,
    });
  } catch (err) {
    console.error("getEngagement error:", err);
    return res.status(500).json({ message: "Server xətası." });
  }
};
