import multer from "multer";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import cloudinary from "../config/cloudinary.js";

const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: "talkmart/videos",
    resource_type: "video",
    allowed_formats: ["mp4", "mov", "avi", "mkv"],
    // Cloudinary avtomatik thumbnail yaradır
    eager: [{ format: "jpg", transformation: [{ width: 400, crop: "scale" }] }],
    eager_async: true,
  },
});

const fileFilter = (req, file, cb) => {
  const allowed = ["video/mp4", "video/quicktime", "video/x-msvideo", "video/x-matroska"];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Yalnız video faylları qəbul edilir (mp4, mov, avi, mkv)."), false);
  }
};

export const uploadVideo = multer({
  storage,
  fileFilter,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
});

// ============================
// IMAGE UPLOADS
// ============================
const imageStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: "talkmart/images",
    resource_type: "image",
    allowed_formats: ["jpg", "jpeg", "png", "webp", "gif"],
  },
});

const imageFilter = (req, file, cb) => {
  const allowedImages = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  if (allowedImages.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Yalnız şəkil faylları qəbul edilir (jpg, png, webp, gif)."), false);
  }
};

export const uploadImage = multer({
  storage: imageStorage,
  fileFilter: imageFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB per image limit
});
