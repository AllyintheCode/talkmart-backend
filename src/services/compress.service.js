import sharp from "sharp";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";

// ffmpeg yolunu təyin et
ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobeStatic.path);

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
    await new Promise((resolve, reject) => {
      const command = ffmpeg(inputPath)
        .inputOptions(["-protocol_whitelist file,pipe"])
        .videoCodec("libx264")
        .outputOptions([
          "-threads 2",
          "-crf 23",
          "-preset fast",
          "-movflags +faststart",
          "-pix_fmt yuv420p",
          "-fs 200M",
        ])
        .audioCodec("aac")
        .audioBitrate("128k")
        .format("mp4")
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
    return {
      outputPath,
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

