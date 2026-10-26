import { Router } from "express";
import {
  verifyProvider, getReports, updateReport, getOperations, retryVideo, retryReportNotification,
  createOnboarding,
  updateOnboarding,
  deleteOnboarding,
  getAllCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  getDashboardStats,
  getAllUsers,
  blockUser,
  unblockUser,
  deleteUser,
  getVideosForReview,
  moderateVideo,
  getAllVideos,
  adminDeleteVideo,
  adminUpdateVideoStatus,
} from "../controllers/admin.controller.js";
import { verifyToken, adminOnly } from "../middlewares/auth.middleware.js";
import { uploadImage } from "../middlewares/upload.middleware.js";

import { validateId } from "../middlewares/api.middleware.js";
const router = Router();
router.param("id", validateId);
router.patch("/users/:id/verify-provider", verifyToken, adminOnly, verifyProvider);
router.get("/reports", verifyToken, adminOnly, getReports);
router.patch("/reports/:id", verifyToken, adminOnly, updateReport);
router.post("/reports/:id/retry-notification", verifyToken, adminOnly, retryReportNotification);
router.get("/operations", verifyToken, adminOnly, getOperations);
router.post("/videos/:id/retry", verifyToken, adminOnly, retryVideo);

// ============================
// İSTİFADƏÇİ ROUTE-ları
// ============================
router.get("/users", verifyToken, adminOnly, getAllUsers);
router.patch("/users/:id/block", verifyToken, adminOnly, blockUser);
router.patch("/users/:id/unblock", verifyToken, adminOnly, unblockUser);
router.delete("/users/:id", verifyToken, adminOnly, deleteUser);


// ============================
// DASHBOARD ROUTE-ları
// ============================
router.get("/dashboard/stats", verifyToken, adminOnly, getDashboardStats);

// ============================
// KATEQORİYA ROUTE-ları
// ============================
router.get("/categories", verifyToken, adminOnly, getAllCategories);
router.post("/categories", verifyToken, adminOnly, createCategory);
router.put("/categories/:id", verifyToken, adminOnly, updateCategory);
router.delete("/categories/:id", verifyToken, adminOnly, deleteCategory);

// ============================
// ONBOARDING ROUTE-ları
// ============================
// Yeni Onboarding yarat (Şəkil yükləmə daxil)
router.post(
  "/onboarding",
  verifyToken,
  adminOnly,
  (req, res, next) => {
    uploadImage.single("image")(req, res, (err) => {
      if (err) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(413).json({ error: "FILE_TOO_LARGE", message: "Şəkil maksimum 10MB ola bilər." });
        }
        if (err.message && err.message.includes("Yalnız şəkil faylları")) {
          return res.status(415).json({ error: "UNSUPPORTED_FORMAT", message: "Yalnız jpg, png, webp, gif qəbul olunur." });
        }
        return res.status(500).json({ error: "UPLOAD_FAILED", message: "Yükləmə xətası.", details: err.message });
      }
      next();
    });
  },
  createOnboarding
);

// Mövcud Onboardingi dəyişmə
router.put(
  "/onboarding/:id",
  verifyToken,
  adminOnly,
  (req, res, next) => {
    uploadImage.single("image")(req, res, (err) => {
      if (err) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(413).json({ error: "FILE_TOO_LARGE", message: "Şəkil maksimum 10MB ola bilər." });
        }
        if (err.message && err.message.includes("Yalnız şəkil faylları")) {
          return res.status(415).json({ error: "UNSUPPORTED_FORMAT", message: "Yalnız jpg, png, webp, gif qəbul olunur." });
        }
        return res.status(500).json({ error: "UPLOAD_FAILED", message: "Yükləmə xətası.", details: err.message });
      }
      next();
    });
  },
  updateOnboarding
);

// Mövcud Onboarding-i silmə
router.delete("/onboarding/:id", verifyToken, adminOnly, deleteOnboarding);

// ============================
// VİDEO İDARƏETMƏSİ ROUTE-ları (ADMIN)
// ============================
router.get("/videos", verifyToken, adminOnly, getAllVideos);
router.delete("/videos/:id", verifyToken, adminOnly, adminDeleteVideo);
router.patch("/videos/:id/status", verifyToken, adminOnly, adminUpdateVideoStatus);
router.get("/videos/moderation", verifyToken, adminOnly, getVideosForReview);
router.patch("/videos/:id/moderate", verifyToken, adminOnly, moderateVideo);

export default router;
