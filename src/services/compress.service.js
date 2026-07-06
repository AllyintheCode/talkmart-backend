import sharp from "sharp";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";

// ffmpeg yolunu təyin et
ffmpeg.setFfmpegPath(ffmpegStatic);

// ============================
// ŞƏKİL SIXIŞDIRMA (sharp)
// ============================

/**
 * Şəkli sıxışdırır — keyfiyyəti qoruyaraq ölçünü kiçildir
 * - JPEG/PNG/GIF/WebP → WebP formatına çevirir (ən yaxşı ölçü/keyfiyyət nisbəti)
 * - Orijinal ölçüləri qoruyur (resize etmir)
 * - Metadata-nı silir (EXIF, GPS və s.)
 *
 * @param {Buffer} buffer - Orijinal şəkil buffer-i
 * @returns {{ buffer: Buffer, ext: string, mimetype: string }}
 */
export const compressImage = async (buffer) => {
  const compressed = await sharp(buffer)
    .webp({ quality: 82 })   // WebP — JPEG-dən ~30-50% kiçik, göz fərq etmir
    .rotate()                 // EXIF rotation-u tətbiq et
    .toBuffer();

  return {
    buffer: compressed,
    ext: ".webp",
    mimetype: "image/webp",
  };
};

// ============================
// VİDEO SIXIŞDIRMA (ffmpeg)
// ============================

/**
 * Videonu sıxışdırır — keyfiyyəti qoruyaraq ölçünü kiçildir
 * - H.264 codec, CRF 23 (vizual fərq hiss olunmur)
 * - AAC audio 128kbps
 * - Orijinal resolution qorunur
 * - Ortalama 40-60% ölçü azalması
 *
 * @param {Buffer} buffer - Orijinal video buffer-i
 * @param {string} originalExt - Orijinal fayl uzantısı (.mp4, .mov, vs.)
 * @returns {{ buffer: Buffer, ext: string, mimetype: string }}
 */
export const compressVideo = async (buffer, originalExt = ".mp4") => {
  // Temp fayllar yarad
  const tmpId = crypto.randomUUID();
  const tmpDir = os.tmpdir();
  const inputPath = path.join(tmpDir, `input_${tmpId}${originalExt}`);
  const outputPath = path.join(tmpDir, `output_${tmpId}.mp4`);

  // Buffer-i diskə yaz
  fs.writeFileSync(inputPath, buffer);

  try {
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .videoCodec("libx264")       // H.264 — ən geniş dəstəklənən codec
        .outputOptions([
          "-crf 23",                  // Keyfiyyət: 18=lossless, 23=default, 28=aşağı. 23 idealdır
          "-preset medium",           // Sürət/keyfiyyət balansı
          "-movflags +faststart",     // Web üçün optimallaşdırma (progressive loading)
          "-pix_fmt yuv420p",         // Bütün player-lərlə uyğunluq
        ])
        .audioCodec("aac")           // AAC audio
        .audioBitrate("128k")        // 128kbps — keyfiyyətli audio
        .format("mp4")
        .on("end", resolve)
        .on("error", reject)
        .save(outputPath);
    });

    const compressedBuffer = fs.readFileSync(outputPath);

    return {
      buffer: compressedBuffer,
      ext: ".mp4",
      mimetype: "video/mp4",
    };
  } finally {
    // Temp faylları təmizlə
    try { fs.unlinkSync(inputPath); } catch (_) {}
    try { fs.unlinkSync(outputPath); } catch (_) {}
  }
};

/**
 * Videodan thumbnail yaradır
 * - Videonun 1-ci saniyəsindəki frame-i götürür
 * - Şəkil kimi sıxışdırıb qaytarır
 *
 * @param {Buffer} buffer - Video buffer-i
 * @param {string} originalExt - Fayl uzantısı
 * @returns {Promise<{ buffer: Buffer, ext: string, mimetype: string }>}
 */
export const generateThumbnail = async (buffer, originalExt = ".mp4") => {
  const tmpId = crypto.randomUUID();
  const tmpDir = os.tmpdir();
  const inputPath = path.join(tmpDir, `thumb_in_${tmpId}${originalExt}`);
  const outputFilename = `thumb_out_${tmpId}.png`;
  const outputPath = path.join(tmpDir, outputFilename);

  fs.writeFileSync(inputPath, buffer);

  try {
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .screenshots({
          timestamps: ["50%"], // Videonun ortası
          filename: outputFilename,
          folder: tmpDir,
          size: "640x?",
        })
        .on("end", resolve)
        .on("error", reject);
    });

    const thumbnailBuffer = fs.readFileSync(outputPath);
    
    // Şəkli sıxışdır
    return await compressImage(thumbnailBuffer);
  } finally {
    try { fs.unlinkSync(inputPath); } catch (_) {}
    try { fs.unlinkSync(outputPath); } catch (_) {}
  }
};
