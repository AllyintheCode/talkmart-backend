import PQueue from "p-queue";
import fs from "fs";
import os from "os";
import Video from "../models/Video.js";
import { compressVideo, generateThumbnail } from "./compress.service.js";
import { uploadToR2, deleteFromR2 } from "./r2Upload.service.js";
import { validateVideoContentAI } from "./aiModeration.service.js";
import { delCachePattern } from "../config/redis.js";

// ============================================================
// İKİ AYRI NÖVBƏ
// - AI növbəsi: I/O-bound (Gemini cavabını gözləyir) → yüksək concurrency
// - Encode növbəsi: CPU-bound (libx264 bütün nüvələri istifadə edir) → aşağı concurrency
// ============================================================
const AI_CONCURRENCY = parseInt(process.env.AI_CONCURRENCY || "6", 10);
const ENCODE_CONCURRENCY = parseInt(
  process.env.ENCODE_CONCURRENCY || String(Math.max(1, Math.floor(os.cpus().length / 4))),
  10,
);

const aiQueue = new PQueue({ concurrency: AI_CONCURRENCY });
const encodeQueue = new PQueue({ concurrency: ENCODE_CONCURRENCY });

/**
 * Paralel Video Emalı Pipeline
 * 1. AI moderasiyası və FFMPEG sıxışdırma EYNİ ANDA başlayır (ümumi vaxt = max(AI, encode))
 * 2. AI rədd edərsə, ffmpeg prosesi dərhal öldürülür (CPU itkisi minimal)
 * 3. Təsdiq edilərsə, hazır sıxışdırılmış video + thumbnail R2-yə paralel yüklənir
 * 4. Admin emal zamanı qərar veribsə, admin qərarı AI nəticəsindən üstündür
 */
const processVideoJob = async ({ videoId, tempFilePath, originalExt, categoryName, duration, title, description }) => {
  console.log(`⚙️ Video emalı başladı: ${videoId}`);

  const encodeAbort = new AbortController();
  let encodeStarted = false;
  let encodePromise = null;

  try {
    await Video.findByIdAndUpdate(videoId, { processingStatus: "processing" });

    // Spekulyativ encode: AI-ı gözləmədən başlayır
    encodePromise = encodeQueue.add(async () => {
      if (encodeAbort.signal.aborted) return null; // növbədə gözləyərkən ləğv olunub
      encodeStarted = true;
      const [compressed, thumbData] = await Promise.all([
        compressVideo(tempFilePath, originalExt, { signal: encodeAbort.signal }),
        generateThumbnail(tempFilePath, originalExt).catch((e) => {
          console.warn(`⚠️ Thumbnail xətası: ${e.message}`);
          return null;
        }),
      ]);
      return { compressed, thumbData };
    });
    encodePromise.catch(() => {}); // AI gözlənilərkən "unhandled rejection" olmasın

    console.log(`🤖 AI analizi başladı: ${videoId}`);
    const aiCheckResult = await aiQueue.add(() =>
      validateVideoContentAI({ tempFilePath, categoryName, duration, title, description }),
    );

    // Admin emal zamanı qərar veribsə (approve → status dəyişir, reject → video silinir),
    // admin qərarı AI nəticəsindən üstündür.
    const current = await Video.findById(videoId).select("moderationStatus").lean();
    if (!current) {
      console.log(`🗑️ Video emal zamanı silinib (admin reject və ya provider delete): ${videoId}`);
      return;
    }
    const adminApproved = current.moderationStatus === "approved";
    const effectiveStatus = adminApproved ? "approved" : aiCheckResult.finalStatus;

    let videoUrl = "";
    let publicId = "";
    let thumbnail = "";
    let thumbKey = "";

    if (effectiveStatus !== "rejected") {
      console.log(`✅ İcazə verildi (${effectiveStatus}${adminApproved ? ", admin" : ", AI"}). Encode nəticəsi gözlənilir...`);

      const encoded = await encodePromise;
      if (!encoded) throw new Error("Encode nəticəsi alınmadı");
      const { compressed, thumbData } = encoded;

      const [r2Video, r2Thumb] = await Promise.all([
        uploadToR2(compressed.buffer, "talkmart/videos", compressed.mimetype, compressed.ext),
        thumbData
          ? uploadToR2(thumbData.buffer, "talkmart/thumbnails", thumbData.mimetype, thumbData.ext).catch((e) => {
              console.warn(`⚠️ Thumbnail yükləmə xətası: ${e.message}`);
              return { url: "", key: "" };
            })
          : { url: "", key: "" },
      ]);

      videoUrl = r2Video.url;
      publicId = r2Video.key;
      thumbnail = r2Thumb.url;
      thumbKey = r2Thumb.key || "";
    } else {
      encodeAbort.abort(); // ffmpeg-i dayandır
      console.log(`🚫 Video AI tərəfindən rədd edildi! Encode dayandırıldı, R2 mərhələsi ləğv olundu. [${videoId}]`);
    }

    // DB-ni yekunlaşdırıb yeniləyirik
    const video = await Video.findById(videoId);
    if (!video) {
      // Yükləmə zamanı silinib — R2-də yetim fayl qalmasın
      await Promise.all([deleteFromR2(publicId), deleteFromR2(thumbKey)]).catch(() => {});
      console.log(`🗑️ Video yükləmə zamanı silinib, R2 faylları təmizləndi: ${videoId}`);
      return;
    }

    // Yükləmə zamanı admin approve edibsə və fayl varsa, admin qərarını saxla
    const finalStatus =
      video.moderationStatus === "approved" && videoUrl ? "approved" : effectiveStatus;

    video.videoUrl = videoUrl;
    video.publicId = publicId;
    video.thumbnail = thumbnail;
    video.processingStatus = "ready";

    video.moderationStatus = finalStatus;
    video.aiFeedback = aiCheckResult.aiData?.reasoning || "";
    video.aiConfidence = aiCheckResult.aiData?.confidenceScore || 0;

    // approved → Feed-ə çıxır; rejected / review → inactive
    video.status = finalStatus === "approved" ? "active" : "inactive";

    await video.save();
    if (video.status === "active") {
      await delCachePattern("feed:*");
      await delCachePattern("categories:top:*");
    }
    console.log(`✅ Video tam emal edildi: ${videoId} | Status: ${finalStatus}`);
  } catch (err) {
    console.error(`❌ Video emalı xətası [${videoId}]:`, err.message);
    await Video.findByIdAndUpdate(videoId, {
      processingStatus: "failed",
      moderationStatus: "review",
      aiFeedback: "Sistemdə xəta baş verdi, emal yarımçıq qaldı.",
    }).catch(() => {});
  } finally {
    // Encode hələ işləyirsə dayandır və bitməsini gözlə (temp faylı ffmpeg oxuyarkən silməyək).
    // Növbədə hələ başlamayıbsa, gözləmirik — başlayanda abort-u görüb dərhal çıxacaq.
    encodeAbort.abort();
    if (encodePromise && encodeStarted) {
      await encodePromise.catch(() => {});
    }
    try {
      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    } catch (_) {}
  }
};

export const enqueueVideoProcessing = ({ videoId, tempFilePath, originalExt, categoryName, duration, title, description }) => {
  processVideoJob({ videoId, tempFilePath, originalExt, categoryName, duration, title, description }).catch((err) =>
    console.error("Video emalı xətası:", err),
  );

  console.log(
    `📋 Video emala verildi: ${videoId} | AI növbəsi: ${aiQueue.size} | Encode növbəsi: ${encodeQueue.size}`,
  );
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

// createVideo cavabındakı queue.position / queue.running formatı qorunur
export const getQueueStats = () => ({
  queued: Math.max(aiQueue.size, encodeQueue.size),
  running: Math.max(aiQueue.pending, encodeQueue.pending),
  concurrency: { ai: AI_CONCURRENCY, encode: ENCODE_CONCURRENCY },
});
