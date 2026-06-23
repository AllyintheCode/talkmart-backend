import multer from "multer";
import path from "path";

// ============================
// MEMORY STORAGE — Fayl RAM-da saxlanılır, controller-dən R2-yə yüklənir
// ============================
const storage = multer.memoryStorage();

// ============================
// VIDEO UPLOAD
// ============================
const videoFilter = (req, file, cb) => {
  const allowed = ["video/mp4", "video/quicktime", "video/x-msvideo", "video/x-matroska"];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Yalnız video faylları qəbul edilir (mp4, mov, avi, mkv)."), false);
  }
};

export const uploadVideo = multer({
  storage,
  fileFilter: videoFilter,
  limits: { fileSize: 250 * 1024 * 1024 }, // 250 MB
});

// ============================
// IMAGE UPLOAD
// ============================
const imageFilter = (req, file, cb) => {
  const allowedImages = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  if (allowedImages.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Yalnız şəkil faylları qəbul edilir (jpg, png, webp, gif)."), false);
  }
};

export const uploadImage = multer({
  storage,
  fileFilter: imageFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB per image limit
});
