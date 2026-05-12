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
  getLikedVideos,
  getSavedVideos,
} from "../controllers/engagement.controller.js";
import { verifyToken, providerOnly, requireAuth, optionalAuth } from "../middlewares/auth.middleware.js";
import { uploadVideo } from "../middlewares/upload.middleware.js";
import { engagementLimiter } from "../middlewares/rateLimit.middleware.js";

const router = Router();

// ============================
// PUBLIC FEED / EXPLORE ROUTE-ları
// optionalAuth: guest izləyə bilər, login olanlar üçün isLiked/isSaved qaytarılır
// ============================
router.get("/feed", optionalAuth, getFeedVideos);
router.get("/explore", optionalAuth, getExploreVideos);

// ============================
// Liked / Saved videolar — LOGIN TƏLƏB OLUNUR
// ============================
router.get("/liked", requireAuth, getLikedVideos);
router.get("/saved", requireAuth, getSavedVideos);

// ============================
// Engagement — Görüntülənmə (guest + login)
// optionalAuth: guest anonim view edə bilər
// ============================
router.post("/:id/view", optionalAuth, engagementLimiter, recordView);

// ============================
// Engagement statusu (like/save sayları)
// optionalAuth: guest sayları görə bilər, isLiked/isSaved = false olacaq
// ============================
router.get("/:id/engagement", optionalAuth, getEngagement);

// ============================
// Like / Save — LOGIN TƏLƏB OLUNUR
// requireAuth: token yoxdursa → 401 + LOGIN_REQUIRED
// Mobil tətbiq bu kodu alıb login ekranına yönləndirir
// ============================
router.post("/:id/like", requireAuth, engagementLimiter, toggleLike);
router.post("/:id/save", requireAuth, engagementLimiter, toggleSave);

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
