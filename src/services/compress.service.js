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
// Remux (re-encode-suz) üçün hədlər — .env ilə dəyişdirilə bilər
const MAX_VIDEO_DIMENSION = parseInt(process.env.MAX_VIDEO_DIMENSION || "1280", 10);
const REMUX_MAX_BITRATE = parseInt(process.env.REMUX_MAX_BITRATE || "6000000", 10); // 6 Mbps

const probe = (inputPath) =>
  new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, metadata) => (err ? reject(err) : resolve(metadata)));
  });

/**
 * Video artıq web üçün uyğundursa (H.264 + yuv420p + AAC/səssiz, mp4/mov,
 * ölçü və bitrate hədd daxilində) yenidən kodlaşdırmağa ehtiyac yoxdur — sadəcə remux.
 */
const canRemux = (metadata) => {
  const streams = metadata?.streams || [];
  const v = streams.find((s) => s.codec_type === "video");
  const audios = streams.filter((s) => s.codec_type === "audio");
  if (!v) return false;

  const formatOk = /mp4|mov/.test(metadata?.format?.format_name || "");
  const codecOk = v.codec_name === "h264" && v.pix_fmt === "yuv420p";
  const audioOk = audios.every((a) => a.codec_name === "aac");
  const sizeOk = Math.max(v.width || 0, v.height || 0) <= Math.max(MAX_VIDEO_DIMENSION, 1920);
  const bitrate = Number(metadata?.format?.bit_rate) || Infinity;
  const bitrateOk = bitrate <= REMUX_MAX_BITRATE;

  return formatOk && codecOk && audioOk && sizeOk && bitrateOk;
};

const makeAbortError = () => {
  const e = new Error("Video emalı ləğv edildi");
  e.name = "AbortError";
  return e;
};

// ffmpeg əmrini icra edir, signal abort olarsa prosesi dərhal öldürür
const runFfmpeg = (command, outputPath, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(makeAbortError());
    const onAbort = () => {
      try { command.kill("SIGKILL"); } catch (_) {}
      reject(makeAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    command
      .on("end", () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      })
      .on("error", (err) => {
        signal?.removeEventListener("abort", onAbort);
        reject(signal?.aborted ? makeAbortError() : err);
      })
      .save(outputPath);
  });

/**
 * @param {Buffer|string} input
 * @param {string} originalExt
 * @param {{ signal?: AbortSignal }} [options] - signal abort olarsa ffmpeg dayandırılır
 */
export const compressVideo = async (input, originalExt = ".mp4", { signal } = {}) => {
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
    let done = false;

    // 1. Sürətli yol: re-encode-suz remux (millisaniyələr)
    try {
      const metadata = await probe(inputPath);
      if (canRemux(metadata)) {
        await runFfmpeg(
          ffmpeg(inputPath).outputOptions([
            "-map 0:v:0",
            "-map 0:a:0?",
            "-c copy",
            "-movflags +faststart",
          ]).format("mp4"),
          outputPath,
          signal,
        );
        done = true;
        console.log("⚡ Video remux edildi (re-encode lazım olmadı)");
      }
    } catch (remuxErr) {
      if (remuxErr.name === "AbortError") throw remuxErr;
      console.warn(`⚠️ Remux alınmadı, re-encode edilir: ${remuxErr.message}`);
    }

    // 2. Re-encode: veryfast + ölçü həddi (məs. 1080x1920 → 720x1280) + maks 30fps
    if (!done) {
      await runFfmpeg(
        ffmpeg(inputPath)
          .videoCodec("libx264")
          .outputOptions([
            "-crf 23",
            "-preset veryfast",
            `-vf scale='min(${MAX_VIDEO_DIMENSION},iw)':'min(${MAX_VIDEO_DIMENSION},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`,
            "-fpsmax 30",
            "-movflags +faststart",
            "-pix_fmt yuv420p",
          ])
          .audioCodec("aac")
          .audioBitrate("128k")
          .format("mp4"),
        outputPath,
        signal,
      );
    }

    const compressedBuffer = fs.readFileSync(outputPath);

    return {
      buffer: compressedBuffer,
      ext: ".mp4",
      mimetype: "video/mp4",
    };
  } finally {
    if (isTempInput) {
      try { fs.unlinkSync(inputPath); } catch (_) {}
    }
    try { fs.unlinkSync(outputPath); } catch (_) {}
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
      ffmpeg()
        .input(inputPath)
        .inputOptions(["-ss 00:00:00.500"]) // Fast input seek
        .outputOptions(["-vframes 1"])
        .output(outputPath)
        .on("end", resolve)
        .on("error", reject)
        .run();
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

