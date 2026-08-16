import PQueue from "p-queue";
import fs from "fs";
import Video from "../models/Video.js";
import { compressVideo, generateThumbnail } from "./compress.service.js";
import { uploadToR2 } from "./r2Upload.service.js";
import { analyzeVideoWithAI } from "./aiModeration.service.js";

// ============================================================
// FFMPEG sıxışdırma + R2 yüklə queue
// Eyni anda maksimum 2 video işlənsin (CPU-nu qorumaq üçün)
// ============================================================
const processingQueue = new PQueue({ concurrency: 2 });

/**
 * Video emalı pipeline
 * 1. Temp fayldan buffer oxu
 * 2. FFMPEG ilə sıxışdır
 * 3. R2-yə yüklə
 * 4. Thumbnail yarat + R2-yə yüklə
 * 5. DB-ni yenilə (videoUrl, publicId, thumbnail, status → pending)
 * 6. AI analizini növbəyə ver
 */
const processVideoJob = async ({ videoId, tempFilePath, originalExt }) => {
  console.log(`⚙️ Video emalı başladı: ${videoId}`);

  try {
    // 1. Temp fayldan buffer oxu
    const rawBuffer = fs.readFileSync(tempFilePath);
    const originalSize = rawBuffer.length;

    // 2. FFMPEG sıxışdırma
    const compressed = await compressVideo(rawBuffer, originalExt);
    const compressedSize = compressed.buffer.length;
    const savedPercent = ((1 - compressedSize / originalSize) * 100).toFixed(1);
    console.log(
      `📦 Sıxışdırma: ${(originalSize / 1024 / 1024).toFixed(2)}MB → ` +
      `${(compressedSize / 1024 / 1024).toFixed(2)}MB (${savedPercent}% azalma) [Video: ${videoId}]`
    );

    // 3. R2-yə video yüklə
    const { key: videoKey, url: videoUrl } = await uploadToR2(
      compressed.buffer,
      "talkmart/videos",
      compressed.mimetype,
      compressed.ext
    );

    // 4. Thumbnail yarat + yüklə
    let thumbnail = "";
    try {
      const thumbData = await generateThumbnail(rawBuffer, originalExt);
      const { url: thumbnailUrl } = await uploadToR2(
        thumbData.buffer,
        "talkmart/thumbnails",
        thumbData.mimetype,
        thumbData.ext
      );
      thumbnail = thumbnailUrl;
      console.log(`📸 Thumbnail hazır: ${videoId}`);
    } catch (thumbErr) {
      console.warn(`⚠️ Thumbnail xətası (video yenə də yüklənəcək): ${thumbErr.message}`);
    }

    // 5. DB-ni video URL + thumbnail ilə yenilə
    await Video.findByIdAndUpdate(videoId, {
      videoUrl,
      publicId: videoKey,
      thumbnail,
      processingStatus: "ready", // emal tamamlandı
    });

    console.log(`✅ Video emalı tamamlandı: ${videoId}`);

    // 6. AI növbəsinə göndər
    analyzeVideoWithAI(videoId);

  } catch (err) {
    console.error(`❌ Video emalı xətası [${videoId}]:`, err.message);
    // Emal alınmasa → processing_failed statusu
    await Video.findByIdAndUpdate(videoId, {
      processingStatus: "failed",
      moderationStatus: "review",
      aiFeedback: "Video emalı zamanı server xətası baş verdi.",
    }).catch(() => {});

  } finally {
    // Temp faylı hər halda sil
    try {
      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    } catch (_) {}
  }
};

/**
 * Upload bitən kimi çağırılır.
 * Temp faylı qeyd edib queue-ya verir, dərhal qayıdır.
 */
export const enqueueVideoProcessing = ({ videoId, tempFilePath, originalExt }) => {
  processingQueue
    .add(() => processVideoJob({ videoId, tempFilePath, originalExt }))
    .catch((err) => console.error("Processing queue xətası:", err));

  console.log(
    `📋 Video emal növbəsinə əlavə edildi: ${videoId} | ` +
    `Növbədə: ${processingQueue.size} | İşləyir: ${processingQueue.pending}`
  );
};

/**
 * Queue statistikası (optional, admin üçün)
 */
export const getQueueStats = () => ({
  queued: processingQueue.size,
  running: processingQueue.pending,
  concurrency: 2,
});
