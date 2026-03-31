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
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
});
