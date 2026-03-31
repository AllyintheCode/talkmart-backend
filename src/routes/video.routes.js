import { Router } from "express";
import {
  createVideo,
  getMyVideos,
  deleteVideo,
  getFeedVideos,
  getExploreVideos,
} from "../controllers/video.controller.js";
import {
  toggleLike,
  toggleSave,
  recordView,
  getEngagement,
} from "../controllers/engagement.controller.js";
import { verifyToken, providerOnly } from "../middlewares/auth.middleware.js";
import { uploadVideo } from "../middlewares/upload.middleware.js";
import { engagementLimiter } from "../middlewares/rateLimit.middleware.js";

const router = Router();

// ============================
// PUBLIC FEED / EXPLORE ROUTE-ları
// ============================
router.get("/feed", getFeedVideos);
router.get("/explore", getExploreVideos);

// ============================
//  Engagement route-ları (user + provider)
//  verifyToken + rate limiter
// ============================
router.post("/:id/like", verifyToken, engagementLimiter, toggleLike);
router.post("/:id/save", verifyToken, engagementLimiter, toggleSave);
router.post("/:id/view", verifyToken, engagementLimiter, recordView);
router.get("/:id/engagement", verifyToken, getEngagement);

// ============================
//  Provider-only route-lar
// ============================

// POST /api/videos/upload  →  video + description + price
router.post("/upload", verifyToken, providerOnly, (req, res, next) => {
  uploadVideo.single("video")(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({
          error: "FILE_TOO_LARGE",
          message: "Video faylın həcmi çox böyükdür (Maksimum 500MB).",
        });
      }
      if (err.message && err.message.includes("Yalnız video faylları")) {
        return res.status(415).json({
          error: "UNSUPPORTED_FORMAT",
          message: "Dəstəklənməyən media formatı (Yalnız mp4, mov, avi, mkv).",
        });
      }
      // Timeout və ya connection reset (İnternet kəsilməsi)
      if (err.code === "ECONNRESET" || err.message.includes("network") || err.message.includes("timeout")) {
        return res.status(408).json({
          error: "NETWORK_ERROR",
          message: "İnternet bağlantısı kəsildi və ya zaman aşımı oldu.",
        });
      }
      // Digər upload xətaları
      return res.status(500).json({ 
        error: "UPLOAD_FAILED",
        message: "Video yüklənməsi zamanı xəta baş verdi.",
        details: err.message
      });
    }
    next();
  });
}, createVideo);

// GET /api/videos/my-videos  →  providerin öz videoları
router.get("/my-videos", verifyToken, providerOnly, getMyVideos);

// DELETE /api/videos/:id  →  videonu sil
router.delete("/:id", verifyToken, providerOnly, deleteVideo);

export default router;
