import { Router } from "express";
import { createVideo, getMyVideos, deleteVideo } from "../controllers/video.controller.js";
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
      return res.status(400).json({ message: err.message });
    }
    next();
  });
}, createVideo);

// GET /api/videos/my-videos  →  providerin öz videoları
router.get("/my-videos", verifyToken, providerOnly, getMyVideos);

// DELETE /api/videos/:id  →  videonu sil
router.delete("/:id", verifyToken, providerOnly, deleteVideo);

export default router;
