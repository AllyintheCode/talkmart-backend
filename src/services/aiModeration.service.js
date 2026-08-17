import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";
import fs from "fs";
import path from "path";
import os from "os";
import axios from "axios";
import Video from "../models/Video.js";
import PQueue from "p-queue";

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
    timeout: 60000 // 1 dəqiqə timeout
  });

  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on("finish", () => resolve(tempPath));
    writer.on("error", reject);
  });
};

/**
 * AI Analizi üçün asinxron funksiya
 */
const processVideoWithAI = async (videoId) => {
  const { genAI, fileManager } = getClients();

  if (!genAI || !fileManager) {
    console.warn("⚠️ GEMINI_API_KEY tapılmadı, AI analizi keçilir.");
    return;
  }

  let tempFilePath = null;
  let uploadResult = null;

  try {
    const video = await Video.findById(videoId).populate("categoryId");
    if (!video) return;

    console.log(`🤖 AI Analizi başladı: Video ID ${videoId}`);
    
    // 1. Videonu müvəqqəti fayla yüklə
    tempFilePath = await downloadVideoToTemp(video.videoUrl);
    
    // 2. Videonu Gemini-yə yüklə
    uploadResult = await fileManager.uploadFile(tempFilePath, {
      mimeType: "video/mp4",
      displayName: `Video-${videoId}`,
    });
    
    console.log(`📥 Video Gemini-yə yükləndi: ${uploadResult.file.uri}`);
    
    // 3. Videonun proses olunmasını gözlə (Max 5 dəqiqə limit)
    let fileState = await fileManager.getFile(uploadResult.file.name);
    let attempts = 0;
    while (fileState.state === "PROCESSING") {
      if (attempts > 60) { // 60 * 5s = 300s = 5 dəqiqə timeout
         throw new Error("Gemini processing timeout");
      }
      process.stdout.write(".");
      await new Promise((resolve) => setTimeout(resolve, 5000));
      fileState = await fileManager.getFile(uploadResult.file.name);
      attempts++;
    }
    
    if (fileState.state === "FAILED") {
      throw new Error("Video processing failed in Gemini");
    }

    // 4. Structured Output üçün Schema təyin edirik
    const schema = {
      type: SchemaType.OBJECT,
      properties: {
        serviceProvided: {
          type: SchemaType.STRING,
          description: "Videoda göstərilən xidmət və ya fəaliyyətin qısa təsviri"
        },
        matchesCategory: {
          type: SchemaType.BOOLEAN,
          description: "Göstərilən xidmət seçilmiş kateqoriyaya uyğundurmu?"
        },
        hasBannedContent: {
          type: SchemaType.BOOLEAN,
          description: "Videoda pornoqrafik, şiddət, qeyri-qanuni və ya təhqiredici məzmun varmı?"
        },
        confidenceScore: {
          type: SchemaType.INTEGER,
          description: "Qərarınızdan nə qədər əminsiniz? (0-dan 100-ə qədər tam ədəd)"
        },
        reasoning: {
          type: SchemaType.STRING,
          description: "Qərarınızın səbəbi (maksimum 2 cümlə, Azərbaycan dilində)"
        }
      },
      required: ["serviceProvided", "matchesCategory", "hasBannedContent", "confidenceScore", "reasoning"]
    };

    const categoryName = video.categoryId ? video.categoryId.name : "Naməlum kateqoriya";
    const prompt = `Sən bir video moderatorusan. Videonu diqqətlə izlə və aşağıdakı sualları cavabla: 1) Videoda hansı xidmət göstərilir? 2) Bu xidmət '${categoryName}' kateqoriyasına uyğundurmu? 3) Uyğunsuz/qadağan olunmuş məzmun varmı? Qərarının səbəbini və əminlik dərəcəni (0-100) mütləq qeyd et.`;

    // 5. Modeldən cavab al (gemini-3.5-flash)
    const model = genAI.getGenerativeModel({ 
      model: "gemini-3.5-flash",
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: schema,
      }
    });

    let result = null;
    let generateAttempts = 0;
    while (generateAttempts < 3) {
      try {
        result = await model.generateContent([
          {
            fileData: {
              mimeType: uploadResult.file.mimeType,
              fileUri: uploadResult.file.uri
            }
          },
          { text: prompt },
        ]);
        break;
      } catch (err) {
        generateAttempts++;
        if (generateAttempts >= 3) throw err;
        console.warn(`⚠️ Gemini API cəhd ${generateAttempts} uğursuz oldu (${err.message}). 2 saniyə sonra yenidən yoxlanılır...`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    const responseText = result.response.text();
    const aiData = JSON.parse(responseText);
    console.log(`✅ AI Nəticəsi:`, aiData);

    // 6. Backend Qərarı
    let finalStatus = "approved";

    if (aiData.hasBannedContent) {
      finalStatus = "rejected";
    } else if (aiData.matchesCategory === false) {
      finalStatus = "rejected";
    } else if (aiData.confidenceScore < 60) {
      finalStatus = "review";
    } else if (aiData.matchesCategory === true && aiData.confidenceScore >= 60 && aiData.confidenceScore <= 84) {
      finalStatus = "review";
    } else if (aiData.matchesCategory === true && aiData.confidenceScore >= 85) {
      finalStatus = "approved";
    }

    // 7. DB-ni yenilə
    video.aiFeedback = aiData.reasoning;
    video.aiConfidence = aiData.confidenceScore;
    video.moderationStatus = finalStatus;
    
    if (finalStatus === "approved") {
      video.status = "active";
    } else {
      video.status = "inactive";
    }

    await video.save();

  } catch (error) {
    console.error("❌ AI Analizi zamanı xəta:", error);
    // Xəta olarsa review-ə atırıq ki, insan baxsın
    await Video.findByIdAndUpdate(videoId, { 
      moderationStatus: "review", 
      aiFeedback: "AI sistemində xəta və ya timeout baş verdi, manual baxış tələb olunur." 
    });
  } finally {
    // 8. Zibil faylları təmizlə
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }
    if (uploadResult) {
      try {
        await fileManager.deleteFile(uploadResult.file.name);
      } catch (err) {
        console.error("Gemini-dən fayl silinə bilmədi:", err.message);
      }
    }
  }
};

/**
 * Yeni video yükləndikdə Task-ı queue-ya əlavə edir
 */
export const analyzeVideoWithAI = (videoId) => {
  queue.add(() => processVideoWithAI(videoId))
       .catch(err => console.error("Queue execution error:", err));
};
