import multer from "multer";
import path from "path";
import os from "os";
import crypto from "crypto";
import fs from "node:fs/promises";

// ============================
// DISK STORAGE (VIDEO) — Video birbaşa SSD diskə axın (stream) şəklində yazılır,
// RAM-ı doldurmur və serverin çökməsinin qarşısını alır.
// ============================
const videoDiskStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, os.tmpdir());
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".mp4";
    const tmpId = crypto.randomUUID();
    const filename = `upload_${tmpId}${ext}`;
    req.videoTempPath = path.join(os.tmpdir(), filename);
    cb(null, filename);
  },
});

// ============================
// MEMORY STORAGE (IMAGE) — Şəkillər kiçik olduğu üçün Sharp emalı üçün RAM-da qalır
// ============================
const memoryStorage = multer.memoryStorage();

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
  storage: videoDiskStorage,
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
  storage: memoryStorage,
  fileFilter: imageFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB per image limit
});

// Own the temporary path even before Multer has attached req.file.
export const receiveVideo = (req, res, next) => {
  const cleanup = () => {
    const target = req.videoTempPath;
    if (target) fs.unlink(target).catch(() => {});
  };
  req.once("aborted", cleanup);
  res.once("close", cleanup);
  uploadVideo.single("video")(req, res, (err) => {
    if (err || req.aborted) cleanup();
    if (req.aborted) return;
    if (err) {
      err.status = err.code === "LIMIT_FILE_SIZE" ? 413 : err.message?.includes("Yalnız video") ? 415 : 400;
      err.code = err.code || "INVALID_UPLOAD";
      return next(err);
    }
    next();
  });
};
