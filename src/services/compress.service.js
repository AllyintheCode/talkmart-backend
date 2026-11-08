import sharp from "sharp";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";
import { validateUploadedVideo } from "./mediaProbe.service.js";

// ffmpeg yolunu təyin et
ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobeStatic.path);

// H.264 level MaxBR values (kbit/s). NAL-rate factors are 1200 for
// Baseline/Main and 1500 for High, as used by FFmpeg's H.264 level check.
// A fixed bandwidth target must not force an otherwise compatible 4K stream
// through a lossy encoder when the chosen policy is to preserve the original.
const H264_LEVEL_MAX_BR = Object.freeze({
  9: 128, 10: 64, 11: 192, 12: 384, 13: 768, 20: 2000, 21: 4000, 22: 4000,
  30: 10000, 31: 14000, 32: 20000, 40: 20000, 41: 50000, 42: 50000,
  50: 135000, 51: 240000, 52: 240000,
});

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
 * Uyğun MP4/H.264 axınını dəyişmədən remux edir; digər girişləri H.264/AAC-a çevirir.
 * Orijinal resolution saxlanılır. Ölçünün azalması fayldan asılıdır.
 *
 * @param {Buffer} buffer - Orijinal video buffer-i
 * @param {string} originalExt - Orijinal fayl uzantısı (.mp4, .mov, vs.)
 * @returns {{ outputPath: string, processingMode: string, cleanup: Function }}
 */
export const compressVideo = async (input, originalExt = ".mp4") => {
  const tmpId = crypto.randomUUID();
  const tmpDir = os.tmpdir();
  let inputPath = "";
  let isTempInput = false;

  if (typeof input === "string" && fs.existsSync(input)) {
    inputPath = input;
  } else {
    inputPath = path.join(tmpDir, `input_${tmpId}${originalExt}`);
    fs.writeFileSync(inputPath, input);
    isTempInput = true;
  }

  const outputPath = path.join(tmpDir, `output_${tmpId}.mp4`);

  try {
    const metadata = await validateUploadedVideo(inputPath);
    const mode = canRemuxVideo(metadata, fs.statSync(inputPath).size) ? "remux" : "transcode";
    await new Promise((resolve, reject) => {
      const command = ffmpeg(inputPath)
        .inputOptions(["-protocol_whitelist file,pipe", "-threads 2"])
        .outputOptions([`-map 0:${metadata.videoStreamIndex}`,
          ...(metadata.audioStreamIndex !== null ? [`-map 0:${metadata.audioStreamIndex}`] : []),
          "-map_metadata -1", "-map_chapters -1", "-movflags +faststart", "-fs 200M"]);
      if (mode === "remux") command.videoCodec("copy").audioCodec("copy");
      else command.videoCodec("libx264").outputOptions([
          "-threads 2",
          "-crf 23",
          "-preset fast",
          "-pix_fmt yuv420p",
        ]).audioCodec("aac").audioBitrate("128k");
      command.format("mp4")
        .on("end", resolve)
        .on("error", reject)
        .save(outputPath);

      const timer = setTimeout(() => {
        try { command.kill("SIGKILL"); } catch (_) {}
        reject(new Error("FFMPEG_TIMEOUT"));
      }, 180000);
      command.on("end", () => clearTimeout(timer));
      command.on("error", () => clearTimeout(timer));
    });

    if (fs.statSync(outputPath).size >= 200 * 1000 * 1000) throw new Error("VIDEO_OUTPUT_TOO_LARGE");
    const result = await validateUploadedVideo(outputPath);
    if (result.durationSeconds + 0.25 < metadata.durationSeconds) throw new Error("VIDEO_OUTPUT_TRUNCATED");
    return {
      outputPath,
      processingMode: mode,
      ext: ".mp4",
      mimetype: "video/mp4",
      cleanup: () => {
        try { fs.unlinkSync(outputPath); } catch (_) {}
      },
    };
  } catch (err) {
    try { fs.unlinkSync(outputPath); } catch (_) {}
    throw err;
  } finally {
    if (isTempInput) {
      try { fs.unlinkSync(inputPath); } catch (_) {}
    }
  }
};

export function canRemuxVideo(metadata, bytes) {
  const maxBitRate = H264_LEVEL_MAX_BR[metadata.level] * (metadata.profile === "High" ? 1500 : 1200);
  return Boolean(metadata.codec === "h264" && metadata.formatName?.includes("mp4") &&
    metadata.pixelFormat === "yuv420p" && ["Baseline", "Constrained Baseline", "Main", "High"].includes(metadata.profile) &&
    metadata.level > 0 && metadata.level <= 52 && metadata.rotation % 360 === 0 &&
    metadata.frameRate && metadata.frameRate <= 30 && metadata.nominalFrameRate && metadata.nominalFrameRate <= 30 &&
    metadata.bitRate > 0 && metadata.bitRate <= maxBitRate && bytes > 0 && bytes < 195000000 && metadata.streamCount <= 2 &&
    ((!metadata.audioCodec && metadata.audioStreamIndex === null) || (metadata.audioCodec === "aac" && metadata.audioChannels > 0 && metadata.audioChannels <= 2)));
}

/**
 * Videodan thumbnail yaradır
 * - Videonun 0.5-ci saniyəsindəki frame-i sürətli seek ilə götürür
 * - Şəkil kimi sıxışdırıb qaytarır
 *
 * @param {Buffer|string} input - Video buffer-i və ya fayl yolu
 * @param {string} originalExt - Fayl uzantısı
 * @returns {Promise<{ buffer: Buffer, ext: string, mimetype: string }>}
 */
export const generateThumbnail = async (input, originalExt = ".mp4") => {
  const tmpId = crypto.randomUUID();
  const tmpDir = os.tmpdir();
  let inputPath = "";
  let isTempInput = false;

  if (typeof input === "string" && fs.existsSync(input)) {
    inputPath = input;
  } else {
    inputPath = path.join(tmpDir, `thumb_in_${tmpId}${originalExt}`);
    fs.writeFileSync(inputPath, input);
    isTempInput = true;
  }

  const outputFilename = `thumb_out_${tmpId}.png`;
  const outputPath = path.join(tmpDir, outputFilename);

  try {
    await new Promise((resolve, reject) => {
      const command = ffmpeg()
        .input(inputPath)
        .inputOptions(["-ss 00:00:00.500"]) // Fast input seek
        .outputOptions(["-vframes 1"])
        .output(outputPath)
        .on("end", resolve)
        .on("error", reject)
        .run();
      const timer = setTimeout(() => { command.kill("SIGKILL"); reject(new Error("THUMBNAIL_TIMEOUT")); }, 10000);
      command.on("end", () => clearTimeout(timer));
      command.on("error", () => clearTimeout(timer));
    });

    const thumbnailBuffer = fs.readFileSync(outputPath);
    
    // Şəkli sıxışdır
    return await compressImage(thumbnailBuffer);
  } finally {
    if (isTempInput) {
      try { fs.unlinkSync(inputPath); } catch (_) {}
    }
    try { fs.unlinkSync(outputPath); } catch (_) {}
  }
};

/**
 * Videonun uzunluğunu saniyə ilə qaytarır
 * @param {Buffer|string} input - Video buffer-i və ya fayl yolu
 * @param {string} originalExt - Fayl uzantısı
 */
export const getVideoDuration = async (input, originalExt = ".mp4") => {
  let inputPath = "";
  let isTempInput = false;

  if (typeof input === "string" && fs.existsSync(input)) {
    inputPath = input;
  } else {
    const tmpId = crypto.randomUUID();
    const tmpDir = os.tmpdir();
    inputPath = path.join(tmpDir, `dur_in_${tmpId}${originalExt}`);
    fs.writeFileSync(inputPath, input);
    isTempInput = true;
  }

  try {
    const duration = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(inputPath, (err, metadata) => {
        if (err) return reject(err);
        resolve(metadata?.format?.duration || 0);
      });
    });
    return duration; // Saniyə ilə
  } finally {
    if (isTempInput) {
      try { fs.unlinkSync(inputPath); } catch (_) {}
    }
  }
};

