import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import Category from "../src/models/Category.js";
import Video from "../src/models/Video.js";
import { analyzeVideoWithAI } from "../src/services/aiModeration.service.js";

async function runMatchingTest() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to MongoDB.");

  // DƏQİQ UYĞUN KATEQORİYA
  let petCategory = await Category.findOne({ name: "Ev heyvanları və Əyləncə" });
  if (!petCategory) {
    petCategory = await Category.create({
      name: "Ev heyvanları və Əyləncə",
      status: "active"
    });
  }

  const matchingVideo = await Video.create({
    providerId: new mongoose.Types.ObjectId("6a4d0551561d637980a330c2"),
    categoryId: petCategory._id,
    title: "Düzgün Video: Tutuquşu Şousu",
    description: "Tutuquşumuz mahnı oxuyur və oynayır",
    price: 30,
    videoUrl: "https://pub-e5e84bbb39a6492e9188152c41f60197.r2.dev/talkmart/videos/0014ae09-9d39-4d62-a210-8ab9cd5dc5fe.mp4",
    publicId: "test_matching_pet",
    thumbnail: "https://pub-e5e84bbb39a6492e9188152c41f60197.r2.dev/talkmart/thumbnails/65e42db0-75a6-4c10-81d1-06f3503d7101.webp",
    moderationStatus: "pending",
    status: "inactive",
  });

  console.log("\n=======================================================");
  console.log("🚀 DÜZGÜN UYĞUNLAŞMA TESTİ BAŞLADI (Tutuquşu vs Ev heyvanları)");
  console.log("Video ID:", matchingVideo._id.toString());
  console.log("=======================================================");

  analyzeVideoWithAI(matchingVideo._id);

  console.log("\n⏳ AI analizi gözlənilir...");
  
  let attempts = 0;
  while (attempts < 20) {
    await new Promise((r) => setTimeout(r, 4000));
    attempts++;

    const v = await Video.findById(matchingVideo._id).lean();

    if (v && v.moderationStatus !== "pending") {
      console.log("\n=======================================================");
      console.log("🎉 TƏSDİQLƏNMƏ TESTİ NƏTİCƏSİ ALINDI!");
      console.log("=======================================================");

      console.log("Əsas Status (Feed görünürlük):", v.status);
      console.log("Moderasiya Statusu:", v.moderationStatus);
      console.log("AI Əminlik (Confidence):", v.aiConfidence + "%");
      console.log("AI Rəyi / Səbəbi:", v.aiFeedback);

      // Təmizlik
      await Video.deleteOne({ _id: matchingVideo._id });
      await Category.deleteOne({ _id: petCategory._id });
      console.log("\n🧹 Test məlumatları təmizləndi.");

      process.exit(0);
    }
  }

  process.exit(1);
}

runMatchingTest().catch(console.error);
