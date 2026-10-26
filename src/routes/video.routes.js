import { Router } from "express";
import {
  createVideo,
  getMyVideos,
  deleteVideo,
  getFeedVideos,
  getExploreVideos,
  getPublicVideoById,
} from "../controllers/video.controller.js";
import {
  toggleLike,
  toggleSave,
  recordView,
  getEngagement,
  getLikedVideos,
  getSavedVideos,
} from "../controllers/engagement.controller.js";
import { verifyToken, providerOnly, verifiedProviderOnly, requireAuth, optionalAuth } from "../middlewares/auth.middleware.js";
import { receiveVideo } from "../middlewares/upload.middleware.js";
import { engagementLimiter, uploadLimiter } from "../middlewares/rateLimit.middleware.js";

import { uploadQuota } from "../middlewares/uploadQuota.middleware.js";
import { validateId } from "../middlewares/api.middleware.js";
const router = Router();
router.param("id", validateId);

// ============================
// PUBLIC FEED / EXPLORE ROUTE-ları
// optionalAuth: guest izləyə bilər, login olanlar üçün isLiked/isSaved qaytarılır
// ============================
router.get("/feed", optionalAuth, getFeedVideos);
router.get("/explore", optionalAuth, getExploreVideos);

// GET /api/videos/:id/public  →  deep link fallback üçün ictimai video məlumatı (auth tələb olunmur)
router.get("/:id/public", getPublicVideoById);

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
router.delete("/:id/like", requireAuth, engagementLimiter, toggleLike);
router.delete("/:id/save", requireAuth, engagementLimiter, toggleSave);
router.post("/:id/save", requireAuth, engagementLimiter, toggleSave);

// ============================
//  Provider-only route-lar
// ============================

// POST /api/videos/upload  →  video + description + price
router.post("/upload", verifyToken, verifiedProviderOnly, uploadLimiter, uploadQuota, receiveVideo, createVideo);

// GET /api/videos/my-videos  →  providerin öz videoları
router.get("/my-videos", verifyToken, providerOnly, getMyVideos);

// DELETE /api/videos/:id  →  videonu sil
router.delete("/:id", verifyToken, providerOnly, deleteVideo);

export default router;
