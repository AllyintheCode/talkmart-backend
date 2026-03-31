import { Router } from "express";
import { createVideo, getMyVideos, deleteVideo } from "../controllers/video.controller.js";
import { verifyToken, providerOnly } from "../middlewares/auth.middleware.js";
import { uploadVideo } from "../middlewares/upload.middleware.js";

const router = Router();

// Bütün video route-ları yalnız provider üçündür
router.use(verifyToken, providerOnly);

// POST /api/videos/upload  →  video + description + price
router.post("/upload", (req, res, next) => {
  uploadVideo.single("video")(req, res, (err) => {
    if (err) {
      return res.status(400).json({ message: err.message });
    }
    next();
  });
}, createVideo);

// GET /api/videos/my-videos  →  providerin öz videoları
router.get("/my-videos", getMyVideos);

// DELETE /api/videos/:id  →  videonu sil
router.delete("/:id", deleteVideo);

export default router;
