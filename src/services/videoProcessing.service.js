import PQueue from "p-queue";
import fs from "fs";
import Video from "../models/Video.js";
import { compressVideo, generateThumbnail } from "./compress.service.js";
import { uploadToR2 } from "./r2Upload.service.js";
import { validateVideoContentAI } from "./aiModeration.service.js";

// ============================================================
// FFMPEG sıxışdırma + R2 yüklə + AI Analiz queue
// Concurrency 3 — Sürətləndirilmiş preset sayəsində daha çox paralel emal
// ============================================================
const processingQueue = new PQueue({ concurrency: 3 });

/**
 * Paralel və Sürətləndirilmiş Video Emalı Pipeline
 * 1. AI analizi cəmi 2-4 saniyədə bitir (Keyframe + Flash-Lite)
 * 2. Rədd edilərsə, dərhal yekunlaşır (vaxt və resurs itkisi olmur)
 * 3. Təsdiq edilərsə, FFMPEG fast preset və paralel R2 yükləmə icra olunur
 */
const processVideoJob = async ({ videoId, tempFilePath, originalExt, categoryName, duration }) => {
  console.log(`⚙️ Video emalı başladı: ${videoId}`);

  try {
    // 1. Statusu processing edirik
    await Video.findByIdAndUpdate(videoId, { processingStatus: "processing" });

    // Tapşırıq 1: Yüksək sürətli Gemini AI Moderasiyası
    console.log(`🤖 AI analizi başladı: ${videoId}`);
    const aiCheckResult = await validateVideoContentAI({ tempFilePath, categoryName, duration });

    let videoUrl = "";
    let publicId = "";
    let thumbnail = "";

    // Əgər video RƏDD EDİLMƏYİBSƏ, FFMPEG sıxışdırma və paralel R2 yükləməni icra et
    if (aiCheckResult.finalStatus !== "rejected") {
      console.log(`✅ AI icazə verdi (${aiCheckResult.finalStatus}). FFMPEG və paralel R2 yükləməsi başlayır...`);

      // 1. Faylı diskdən birbaşa sürətli preset ilə sıxışdırırıq
      const compressed = await compressVideo(tempFilePath, originalExt);

      // 2. Video upload və Thumbnail yaratma + upload paralel aparılır
      const [r2Video, r2Thumb] = await Promise.all([
        uploadToR2(compressed.buffer, "talkmart/videos", compressed.mimetype, compressed.ext),
        generateThumbnail(tempFilePath, originalExt)
          .then((thumbData) => uploadToR2(thumbData.buffer, "talkmart/thumbnails", thumbData.mimetype, thumbData.ext))
          .catch((e) => {
            console.warn(`⚠️ Thumbnail xətası: ${e.message}`);
            return { url: "" };
          }),
      ]);

      videoUrl = r2Video.url;
      publicId = r2Video.key;
      thumbnail = r2Thumb.url;
    } else {
      console.log(`🚫 Video AI tərəfindən rədd edildi! R2 və Thumbnail mərhələləri ləğv olundu. [${videoId}]`);
    }

    // DB-ni yekunlaşdırıb yeniləyirik
    const video = await Video.findById(videoId);
    if (video) {
      video.videoUrl = videoUrl;
      video.publicId = publicId;
      video.thumbnail = thumbnail;
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

export const enqueueVideoProcessing = ({ videoId, tempFilePath, originalExt, categoryName, duration }) => {
  processingQueue
    .add(() => processVideoJob({ videoId, tempFilePath, originalExt, categoryName, duration }))
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
  concurrency: 3,
});
