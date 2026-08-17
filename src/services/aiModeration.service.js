import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";
import fs from "fs";
import path from "path";
import os from "os";
import axios from "axios";
import Video from "../models/Video.js";
import PQueue from "p-queue";
import { deleteFromR2 } from "./r2Upload.service.js";

const getClients = () => {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { genAI: null, fileManager: null };
  return {
    genAI: new GoogleGenerativeAI(key),
    fileManager: new GoogleAIFileManager(key),
  };
};

// Concurrency: Eyni anda maksimum 2 video işlənsin
const queue = new PQueue({ concurrency: 2 });

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
 * Birbaşa yerli temp video faylını AI ilə yoxlayır
 * Upload zamanı sinxron yoxlama üçün istifadə olunur
 */
export const validateVideoContentAI = async ({ tempFilePath, categoryName }) => {
  const { genAI, fileManager } = getClients();

  if (!genAI || !fileManager) {
    console.warn("⚠️ GEMINI_API_KEY tapılmadı, AI analizi keçilir.");
    return {
      isAllowed: true,
      finalStatus: "review",
      aiData: { reasoning: "AI açarı təyin edilməyib", confidenceScore: 0 },
    };
  }

  let uploadResult = null;
  try {
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

    const prompt = `Sən bir video moderatorusan. Videonu diqqətlə izlə və aşağıdakı sualları cavabla: 1) Videoda hansı xidmət göstərilir? 2) Bu xidmət '${categoryName}' kateqoriyasına uyğundurmu? 3) Uyğunsuz/qadağan olunmuş məzmun varmı? Qərarının səbəbini və əminlik dərəcəni (0-100) mütləq qeyd et.`;

    const model = genAI.getGenerativeModel({
      model: "gemini-3.5-flash",
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: moderationSchema,
      },
    });

    let result = null;
    let generateAttempts = 0;
    while (generateAttempts < 3) {
      try {
        result = await model.generateContent([
          {
            fileData: {
              mimeType: uploadResult.file.mimeType,
              fileUri: uploadResult.file.uri,
            },
          },
          { text: prompt },
        ]);
        break;
      } catch (err) {
        generateAttempts++;
        if (generateAttempts >= 3) throw err;
        console.warn(`⚠️ Gemini API cəhd ${generateAttempts} uğursuz oldu (${err.message}). Yenidən yoxlanılır...`);
        await new Promise((r) => setTimeout(r, 1500));
      }
    }

    const aiData = JSON.parse(result.response.text());
    console.log("🤖 AI Validasiya Nəticəsi:", aiData);

    let finalStatus = "approved";
    if (aiData.hasBannedContent || aiData.matchesCategory === false) {
      finalStatus = "rejected";
    } else if (
      aiData.confidenceScore < 60 ||
      (aiData.matchesCategory === true &&
        aiData.confidenceScore >= 60 &&
        aiData.confidenceScore <= 84)
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
  } finally {
    if (uploadResult) {
      try {
        await fileManager.deleteFile(uploadResult.file.name);
      } catch (_) {}
    }
  }
};

/**
 * Videonu R2-dən müvəqqəti fayla endirir
 */
const downloadVideoToTemp = async (url) => {
  const tempPath = path.join(os.tmpdir(), `video-${Date.now()}.mp4`);
  const writer = fs.createWriteStream(tempPath);

  const response = await axios({
    url,
    method: "GET",
    responseType: "stream",
    timeout: 60000,
  });

  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on("finish", () => resolve(tempPath));
    writer.on("error", reject);
  });
};

/**
 * AI Analizi üçün asinxron arxa plan funksiyası
 */
const processVideoWithAI = async (videoId) => {
  const { genAI, fileManager } = getClients();

  if (!genAI || !fileManager) {
    console.warn("⚠️ GEMINI_API_KEY tapılmadı, AI analizi keçilir.");
    return;
  }

  let tempFilePath = null;

  try {
    const video = await Video.findById(videoId).populate("categoryId");
    if (!video) return;

    console.log(`🤖 AI Analizi başladı: Video ID ${videoId}`);
    tempFilePath = await downloadVideoToTemp(video.videoUrl);

    const categoryName = video.categoryId ? video.categoryId.name : "Naməlum kateqoriya";
    const checkResult = await validateVideoContentAI({ tempFilePath, categoryName });

    if (checkResult.finalStatus === "rejected") {
      console.log(`🚫 Video REJECTED oldu: ${checkResult.aiData?.reasoning}`);
      if (video.publicId) await deleteFromR2(video.publicId).catch(() => {});
      if (video.thumbnail) {
        try {
          const thumbUrl = new URL(video.thumbnail);
          const thumbKey = thumbUrl.pathname.replace(/^\//, "");
          await deleteFromR2(thumbKey).catch(() => {});
        } catch (_) {}
      }
      await video.deleteOne();
      console.log(`🗑️ Rejected video R2 və DB-dən silindi: ${videoId}`);
      return;
    }

    video.aiFeedback = checkResult.aiData?.reasoning || "";
    video.aiConfidence = checkResult.aiData?.confidenceScore || 0;
    video.moderationStatus = checkResult.finalStatus;
    video.status = checkResult.finalStatus === "approved" ? "active" : "inactive";

    await video.save();
  } catch (error) {
    console.error("❌ AI Analizi zamanı xəta:", error);
    await Video.findByIdAndUpdate(videoId, {
      moderationStatus: "review",
      aiFeedback: "AI sistemində xəta və ya timeout baş verdi, manual baxış tələb olunur.",
    });
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try { fs.unlinkSync(tempFilePath); } catch (_) {}
    }
  }
};

/**
 * Yeni video yükləndikdə Task-ı queue-ya əlavə edir
 */
export const analyzeVideoWithAI = (videoId) => {
  queue.add(() => processVideoWithAI(videoId)).catch((err) => console.error("Queue execution error:", err));
};
