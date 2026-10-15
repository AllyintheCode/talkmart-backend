import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

// FFmpeg yollarını sazla
ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobeStatic.path);

let currentKeyIndex = 0;

const getClients = () => {
  const keysString = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "";
  const keys = keysString.split(",").map(k => k.trim()).filter(Boolean);

  if (keys.length === 0) return { genAI: null, fileManager: null, totalKeys: 0, activeKey: "" };

  const activeKey = keys[currentKeyIndex % keys.length];
  return {
    genAI: new GoogleGenerativeAI(activeKey),
    fileManager: new GoogleAIFileManager(activeKey),
    totalKeys: keys.length,
    activeKey,
  };
};

export const switchApiKey = () => {
  const keysString = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "";
  const keys = keysString.split(",").map(k => k.trim()).filter(Boolean);
  if (keys.length > 1) {
    currentKeyIndex = (currentKeyIndex + 1) % keys.length;
    console.log(`🔄 API Açar dəyişdirildi. Yeni açar indeksi: ${currentKeyIndex + 1}/${keys.length}`);
    return true;
  }
  return false;
};

const moderationSchema = {
  type: SchemaType.OBJECT,
  properties: {
    serviceProvided: {
      type: SchemaType.STRING,
      description: "Videoda göstərilən xidmət və ya fəaliyyətin qısa təsviri",
    },
    matchesCategory: {
      type: SchemaType.BOOLEAN,
      description: "Göstərilən xidmət seçilmiş kateqoriyaya uyğundurmu?",
    },
    hasBannedContent: {
      type: SchemaType.BOOLEAN,
      description: "Videoda pornoqrafik, şiddət, qeyri-qanuni və ya təhqiredici məzmun varmı?",
    },
    confidenceScore: {
      type: SchemaType.INTEGER,
      description: "Qərarınızdan nə qədər əminsiniz? (0-dan 100-ə qədər tam ədəd)",
    },
    reasoning: {
      type: SchemaType.STRING,
      description: "Qərarınızın səbəbi (maksimum 2 cümlə, Azərbaycan dilində)",
    },
  },
  required: [
    "serviceProvided",
    "matchesCategory",
    "hasBannedContent",
    "confidenceScore",
    "reasoning",
  ],
};

/**
 * Videodan sürətli paralel keyframe çıxarışı
 * Hər frame optimallaşdırılmış 640px JPEG formatında çıxarılır (~0.4s-0.6s)
 */
export const extractKeyframes = async (filePath, count = 4, knownDuration = null) => {
  let duration = knownDuration;
  if (!duration || duration <= 0) {
    duration = await new Promise((resolve) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) return resolve(5);
        resolve(metadata?.format?.duration || 5);
      });
    }).catch(() => 5);
  }

  const timestamps = [];
  if (duration <= 2) {
    timestamps.push(Math.max(0.2, duration * 0.5));
  } else if (duration <= 5) {
    timestamps.push(duration * 0.25, duration * 0.75);
  } else {
    // Videonun əvvəli, ortası və sonunu əhatə edən 4 nöqtə
    timestamps.push(
      duration * 0.15,
      duration * 0.35,
      duration * 0.60,
      duration * 0.85
    );
  }

  const tmpDir = os.tmpdir();
  const framePromises = timestamps.map((ts) => {
    const outPath = path.join(tmpDir, `kf_${crypto.randomUUID()}.jpg`);
    return new Promise((resolve, reject) => {
      ffmpeg()
        .input(filePath)
        .inputOptions([`-ss ${Number(ts).toFixed(2)}`]) // Fast input seek
        .outputOptions([
          "-vframes 1",
          "-vf scale=640:-2", // AI vizual analizi üçün optimal yüngül ölçü
          "-q:v 3",
        ])
        .output(outPath)
        .on("end", () => {
          try {
            const buf = fs.readFileSync(outPath);
            fs.unlinkSync(outPath);
            resolve(buf.toString("base64"));
          } catch (e) {
            reject(e);
          }
        })
        .on("error", reject)
        .run();
    });
  });

  return await Promise.all(framePromises);
};

const getCandidateModels = () => {
  const models = [
    process.env.GEMINI_MODEL,
    "gemini-flash-lite-latest",
    "gemini-3.5-flash-lite",
    "gemini-3.8-flash",
  ].filter(Boolean);
  return [...new Set(models)];
};

const parseModerationResult = (aiData) => {
  let finalStatus = "approved";
  if (aiData.hasBannedContent || aiData.matchesCategory === false) {
    finalStatus = "rejected";
  } else if (
    aiData.confidenceScore < 60 ||
    (aiData.matchesCategory === true && aiData.confidenceScore >= 60 && aiData.confidenceScore <= 84)
  ) {
    finalStatus = "review";
  } else if (aiData.matchesCategory === true && aiData.confidenceScore >= 85) {
    finalStatus = "approved";
  }

  return {
    isAllowed: finalStatus !== "rejected",
    finalStatus,
    aiData,
  };
};

/**
 * AI Moderasya servisi (Background Queue tərəfindən çağırılır)
 * Yüksək sürətli keyframe + Flash-Lite modeli ilə cəmi 2-4 saniyəyə nəticə verir.
 * tempFilePath ilə işləyir. İşi bitəndə faylı SİLMİR (növbəti mərhələlər istifadə edəcək).
 */
export const validateVideoContentAI = async ({ tempFilePath, categoryName, duration = null }) => {
  const { genAI, totalKeys } = getClients();

  if (!genAI || totalKeys === 0) {
    console.warn("⚠️ GEMINI_API_KEY tapılmadı, AI analizi keçilir.");
    return {
      isAllowed: true,
      finalStatus: "review",
      aiData: { reasoning: "AI açarı təyin edilməyib, manual review.", confidenceScore: 0 },
    };
  }

  const systemPrompt = `Sən Talkmart platformasının peşəkar video moderatorusan.
Satıcıların yüklədiyi xidmət videolarını analiz edirsən.
Aşağıdakı qaydalara ciddi əməl et:
1. Videoda mütləq bir xidmət (service) nümayiş olunmalıdır.
2. Qadağan olunmuş məzmun (şiddət, qeyri-etik, silah, narkotik, açıq-saçıqlıq, qeyri-qanuni əməl) varsa mütləq 'hasBannedContent: true' et.
3. Göstərilən xidmət '${categoryName}' kateqoriyasına uyğundurmu? Dəqiq analiz et.
4. Qərarını 'reasoning' hissəsində maksimum 2 cümlə ilə, konkret faktla və Azərbaycan dilində izah et.
5. 'confidenceScore' (0-100) sənin bu qərarından nə qədər əmin olduğunu göstərsin.`;

  const modelsToTry = getCandidateModels();

  // ============================================================
  // MƏRHƏLƏ 1: Yüksək sürətli Keyframe analizi (1-3 saniyə)
  // Bütün videonu Google serverinə yükləməyə ehtiyac qalmır!
  // ============================================================
  try {
    const keyframes = await extractKeyframes(tempFilePath, 4, duration);
    if (keyframes && keyframes.length > 0) {
      const imageParts = keyframes.map((base64) => ({
        inlineData: {
          mimeType: "image/jpeg",
          data: base64,
        },
      }));

      for (const modelName of modelsToTry) {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const { genAI: activeGenAI } = getClients();
            const model = activeGenAI.getGenerativeModel({
              model: modelName,
              generationConfig: {
                responseMimeType: "application/json",
                responseSchema: moderationSchema,
              },
            });

            const result = await model.generateContent([
              ...imageParts,
              { text: systemPrompt },
            ]);

            const aiData = JSON.parse(result.response.text());
            console.log(`🤖 AI Validasiya Nəticəsi (${modelName}, Keyframe):`, aiData);

            return parseModerationResult(aiData);
          } catch (err) {
            console.warn(`⚠️ Model ${modelName} cəhd ${attempt + 1} xətası: ${err.message}`);
            const isQuotaOrDemand =
              err.message?.includes("429") ||
              err.message?.includes("quota") ||
              err.message?.includes("503") ||
              err.message?.includes("high demand") ||
              err.message?.includes("Too Many Requests");

            if (isQuotaOrDemand) {
              switchApiKey();
            }
          }
        }
      }
    }
  } catch (kfErr) {
    console.warn(`⚠️ Keyframe çıxarışında xəta, ehtiyat metoduna (File API) keçilir: ${kfErr.message}`);
  }

  // ============================================================
  // MƏRHƏLƏ 2 (Ehtiyat): GoogleAIFileManager ilə tam video analizi
  // Yalnız keyframe çıxarışı hər hansı səbəbdən uğursuz olarsa istifadə olunur
  // ============================================================
  let uploadResult = null;
  try {
    const { fileManager } = getClients();
    uploadResult = await fileManager.uploadFile(tempFilePath, {
      mimeType: "video/mp4",
      displayName: `UploadCheck-${Date.now()}`,
    });

    let fileState = await fileManager.getFile(uploadResult.file.name);
    let attempts = 0;
    while (fileState.state === "PROCESSING") {
      if (attempts > 30) throw new Error("Gemini processing timeout");
      await new Promise((resolve) => setTimeout(resolve, 2000));
      fileState = await fileManager.getFile(uploadResult.file.name);
      attempts++;
    }

    if (fileState.state === "FAILED") {
      throw new Error("Video processing failed in Gemini");
    }

    for (const modelName of modelsToTry) {
      try {
        const { genAI: activeGenAI } = getClients();
        const model = activeGenAI.getGenerativeModel({
          model: modelName,
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: moderationSchema,
          },
        });

        const result = await model.generateContent([
          { fileData: { mimeType: uploadResult.file.mimeType, fileUri: uploadResult.file.uri } },
          { text: systemPrompt },
        ]);

        const aiData = JSON.parse(result.response.text());
        console.log(`🤖 AI Validasiya Nəticəsi (${modelName}, File API):`, aiData);

        return parseModerationResult(aiData);
      } catch (err) {
        console.warn(`⚠️ File API cəhdi xətası (${modelName}): ${err.message}`);
        switchApiKey();
      }
    }

    throw new Error("Bütün AI modelləri uğursuz oldu");
  } catch (error) {
    console.error("❌ AI Moderasiya Xətası:", error.message);
    return {
      isAllowed: true,
      finalStatus: "review",
      aiData: { reasoning: "Sistem xətası səbəbindən avtomatik analiz edilə bilmədi, manual baxış tələb olunur.", confidenceScore: 0 },
    };
  } finally {
    if (uploadResult) {
      try {
        const { fileManager } = getClients();
        await fileManager.deleteFile(uploadResult.file.name);
      } catch (_) {}
    }
  }
};

/**
 * Mövcud videonu AI ilə yenidən analiz etmək (Manual / Test / Script üçün)
 */
export const analyzeVideoWithAI = async (videoId) => {
  try {
    const Video = (await import("../models/Video.js")).default;
    const Category = (await import("../models/Category.js")).default;
    const video = await Video.findById(videoId);
    if (!video) return;

    const category = await Category.findById(video.categoryId);
    const categoryName = category?.name || "Xidmət";

    let targetPath = "";
    let isTemp = false;

    if (video.videoUrl) {
      const response = await fetch(video.videoUrl);
      const arrayBuffer = await response.arrayBuffer();
      const tmpPath = path.join(os.tmpdir(), `recheck_${video._id}.mp4`);
      fs.writeFileSync(tmpPath, Buffer.from(arrayBuffer));
      targetPath = tmpPath;
      isTemp = true;
    }

    if (targetPath) {
      const result = await validateVideoContentAI({
        tempFilePath: targetPath,
        categoryName,
        duration: video.duration,
      });

      video.moderationStatus = result.finalStatus;
      video.aiFeedback = result.aiData?.reasoning || "";
      video.aiConfidence = result.aiData?.confidenceScore || 0;
      video.status = result.finalStatus === "approved" ? "active" : "inactive";
      await video.save();

      if (isTemp) {
        try { fs.unlinkSync(targetPath); } catch (_) {}
      }
      return result;
    }
  } catch (err) {
    console.error("analyzeVideoWithAI error:", err);
  }
};
