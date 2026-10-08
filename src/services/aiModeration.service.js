import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";
import fs from "fs";

const getClients = () => {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { genAI: null, fileManager: null };
  return {
    genAI: new GoogleGenerativeAI(key),
    fileManager: new GoogleAIFileManager(key),
  };
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
 * AI Moderasya servisi (Background Queue tərəfindən çağırılır)
 * tempFilePath ilə işləyir. İşi bitəndə faylı SİLMİR (o işi FFMPEG-lə ortaq valide edən tərəf görəcək)
 */
export const validateVideoContentAI = async ({ tempFilePath, categoryName }) => {
  const { genAI, fileManager } = getClients();

  if (!genAI || !fileManager) {
    console.warn("⚠️ GEMINI_API_KEY tapılmadı, AI analizi keçilir.");
    return {
      isAllowed: true,
      finalStatus: "review",
      aiData: { reasoning: "AI açarı təyin edilməyib, manual review.", confidenceScore: 0 },
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

    const systemPrompt = `Sən Talkmart platformasının peşəkar video moderatorusan.
Satıcıların yüklədiyi xidmət videolarını analiz edirsən.
Aşağıdakı qaydalara ciddi əməl et:
1. Videoda mütləq bir xidmət (service) nümayiş olunmalıdır.
2. Qadağan olunmuş məzmun (şiddət, qeyri-etik, silah, narkotik, açıq-saçıqlıq, qeyri-qanuni əməl) varsa mütləq 'hasBannedContent: true' et.
3. Göstərilən xidmət '${categoryName}' kateqoriyasına uyğundurmu? Dəqiq analiz et.
4. Qərarını 'reasoning' hissəsində maksimum 2 cümlə ilə, konkret faktla və Azərbaycan dilində izah et.
5. 'confidenceScore' (0-100) sənin bu qərarından nə qədər əmin olduğunu göstərsin.`;

    const model = genAI.getGenerativeModel({
      model: "gemini-3.8-flash",
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
          { fileData: { mimeType: uploadResult.file.mimeType, fileUri: uploadResult.file.uri } },
          { text: systemPrompt },
        ]);
        break;
      } catch (err) {
        generateAttempts++;
        const isQuotaError = err.message?.includes("429") || err.message?.includes("quota");
        if (isQuotaError) {
          console.warn(`⚠️ Gemini API quota limiti aşıldı. Review statusu veriləcək.`);
          throw err;
        }
        if (generateAttempts >= 3) throw err;
        const delay = generateAttempts * 3000;
        console.warn(`⚠️ Gemini API cəhd ${generateAttempts} uğursuz oldu (${err.message}). ${delay/1000} saniyə sonra yenidən yoxlanılır...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    const aiData = JSON.parse(result.response.text());
    console.log("🤖 AI Validasiya Nəticəsi:", aiData);

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
        await fileManager.deleteFile(uploadResult.file.name);
      } catch (_) {}
    }
  }
};
