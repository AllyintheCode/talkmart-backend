import PQueue from "p-queue";
import fs from "fs";
import Video from "../models/Video.js";
import { compressVideo, generateThumbnail } from "./compress.service.js";
import { uploadToR2 } from "./r2Upload.service.js";
import { validateVideoContentAI } from "./aiModeration.service.js";

// ============================================================
// FFMPEG sıxışdırma + R2 yüklə + AI Analiz queue
// Eyni anda maksimum 2 video işlənsin (CPU-nu qorumaq üçün)
// ============================================================
const processingQueue = new PQueue({ concurrency: 2 });

/**
 * Paralel Video Emalı Pipeline
 * 1. AI analizi və FFMPEG sıxışdırması eyni anda başlayır
 * 2. İkisi də bitəndə DB yenilənir
 */
const processVideoJob = async ({ videoId, tempFilePath, originalExt, categoryName }) => {
  console.log(`⚙️ Video emalı və AI analizi eyni anda başladı: ${videoId}`);

  try {
    // 1. Statusu processing edirik
    await Video.findByIdAndUpdate(videoId, { processingStatus: "processing" });

    // Tapşırıq A: FFMPEG Sıxışdırma + Thumbnail + R2 Yükləmə
    const uploadTask = (async () => {
      const rawBuffer = fs.readFileSync(tempFilePath);
      const originalSize = rawBuffer.length;

      const compressed = await compressVideo(rawBuffer, originalExt);
      const compressedSize = compressed.buffer.length;
      console.log(`📦 Sıxışdırıldı: ${(originalSize/1024/1024).toFixed(2)}MB -> ${(compressedSize/1024/1024).toFixed(2)}MB [${videoId}]`);

      const { key: videoKey, url: videoUrl } = await uploadToR2(compressed.buffer, "talkmart/videos", compressed.mimetype, compressed.ext);

      let thumbnail = "";
      try {
        const thumbData = await generateThumbnail(rawBuffer, originalExt);
        const { url: thumbnailUrl } = await uploadToR2(thumbData.buffer, "talkmart/thumbnails", thumbData.mimetype, thumbData.ext);
        thumbnail = thumbnailUrl;
      } catch (e) {
        console.warn(`⚠️ Thumbnail xətası: ${e.message}`);
      }

      return { videoUrl, publicId: videoKey, thumbnail };
    })();

    // Tapşırıq B: Gemini AI Moderasiyası (temp fayl üzərindən)
    const aiTask = validateVideoContentAI({ tempFilePath, categoryName });

    // Hər iki tapşırığı paralel işlədib nəticələrini gözləyirik
    const [uploadResult, aiCheckResult] = await Promise.all([uploadTask, aiTask]);

    // DB-ni yekunlaşdırıb yeniləyirik
    const video = await Video.findById(videoId);
    if (video) {
      video.videoUrl = uploadResult.videoUrl;
      video.publicId = uploadResult.publicId;
      video.thumbnail = uploadResult.thumbnail;
      video.processingStatus = "ready";
      
      video.moderationStatus = aiCheckResult.finalStatus;
      video.aiFeedback = aiCheckResult.aiData?.reasoning || "";
      video.aiConfidence = aiCheckResult.aiData?.confidenceScore || 0;

      if (aiCheckResult.finalStatus === "approved") {
        video.status = "active"; // İcazə verildi, Feed-ə çıxır
      } else {
        video.status = "inactive"; // Rədd edildi və ya manual baxış lazımdır
      }

      await video.save();
      console.log(`✅ Video tam emal edildi və təsdiqləndi: ${videoId} | Status: ${aiCheckResult.finalStatus}`);
    }

  } catch (err) {
    console.error(`❌ Video emalı xətası [${videoId}]:`, err.message);
    await Video.findByIdAndUpdate(videoId, {
      processingStatus: "failed",
      moderationStatus: "review",
      aiFeedback: "Sistemdə xəta baş verdi, emal yarımçıq qaldı.",
    }).catch(() => {});
  } finally {
    // Hər şey bitdikdən sonra temp faylı silirik
    try {
      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    } catch (_) {}
  }
};

export const enqueueVideoProcessing = ({ videoId, tempFilePath, originalExt, categoryName }) => {
  processingQueue
    .add(() => processVideoJob({ videoId, tempFilePath, originalExt, categoryName }))
    .catch((err) => console.error("Processing queue xətası:", err));

  console.log(`📋 Video növbəyə alındı: ${videoId} | Növbədə: ${processingQueue.size}`);
};

/**
 * Server qəfil sönərsə, yarımçıq qalmış videoları bərpa etmək (Crash Recovery)
 * Bu funksiya server başlayanda (index.js içində) çağırılacaq.
 */
export const recoverStuckVideos = async () => {
  try {
    const stuckVideos = await Video.find({ processingStatus: { $in: ["queued", "processing"] } });
    
    if (stuckVideos.length > 0) {
      console.log(`🧹 ${stuckVideos.length} ədəd yarımçıq emal olunan video tapıldı. "failed" statusuna keçirilir...`);
      for (const v of stuckVideos) {
        v.processingStatus = "failed";
        v.moderationStatus = "review";
        v.aiFeedback = "Server qəzası və ya restart səbəbindən emal yarımçıq qaldı.";
        await v.save();
      }
      console.log("✅ Yarımçıq videolar bərpa edildi.");
    }
  } catch (err) {
    console.error("Crash recovery xətası:", err);
  }
};

export const getQueueStats = () => ({
  queued: processingQueue.size,
  running: processingQueue.pending,
  concurrency: 2,
});
