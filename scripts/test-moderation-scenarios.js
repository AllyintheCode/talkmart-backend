import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import Category from "../src/models/Category.js";
import Video from "../src/models/Video.js";
import { analyzeVideoWithAI } from "../src/services/aiModeration.service.js";

async function runTests() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to MongoDB.");

  // Test 1: SƏHV / UYĞUNSUZ VİDEO TESTİ
  // Kater gəzintisi videosu amma "Bişdüş" (yemək) kateqoriyası ilə
  let wrongCategory = await Category.findOne({ name: "Bişdüş" });
  if (!wrongCategory) {
    wrongCategory = await Category.create({
      name: "Bişdüş",
      status: "active",
    });
  }
  
  const wrongVideo = await Video.create({
    providerId: new mongoose.Types.ObjectId("6a4d0551561d637980a330c2"),
    categoryId: wrongCategory._id,
    title: "Test 1: Səhv Kateqoriya (Kater videosu - Bişdüş kateqoriyası)",
    description: "Katerlə gəzinti xidməti təklif olunur",
    price: 150,
    videoUrl: "https://pub-e5e84bbb39a6492e9188152c41f60197.r2.dev/talkmart/videos/0014ae09-9d39-4d62-a210-8ab9cd5dc5fe.mp4",
    publicId: "test_wrong_1",
    thumbnail: "https://pub-e5e84bbb39a6492e9188152c41f60197.r2.dev/talkmart/thumbnails/65e42db0-75a6-4c10-81d1-06f3503d7101.webp",
    moderationStatus: "pending",
    status: "inactive",
  });

  console.log("\n=======================================================");
  console.log("🚀 TEST 1 BAŞLADI: UYĞUNSUZ VİDEO (Kater vs Bişdüş)");
  console.log("Video ID:", wrongVideo._id.toString());
  console.log("=======================================================");

  analyzeVideoWithAI(wrongVideo._id);

  // Test 2: DÜZGÜN / UYĞUN VİDEO TESTİ
  // "Qayıq və Kater İcarəsi" uyğun kateqoriyası ilə test
  let matchingCategory = await Category.findOne({ name: "Qayıq və Kater İcarəsi" });
  if (!matchingCategory) {
    matchingCategory = await Category.create({
      name: "Qayıq və Kater İcarəsi",
      status: "active"
    });
  }

  const correctVideo = await Video.create({
    providerId: new mongoose.Types.ObjectId("6a4d0551561d637980a330c2"),
    categoryId: matchingCategory._id,
    title: "Test 2: Düzgün Kateqoriya (Kater videosu - Kater İcarəsi kateqoriyası)",
    description: "Komo gölündə katerlə fərdi və qrup şəklində gəzintilər",
    price: 200,
    videoUrl: "https://pub-e5e84bbb39a6492e9188152c41f60197.r2.dev/talkmart/videos/0014ae09-9d39-4d62-a210-8ab9cd5dc5fe.mp4",
    publicId: "test_correct_2",
    thumbnail: "https://pub-e5e84bbb39a6492e9188152c41f60197.r2.dev/talkmart/thumbnails/65e42db0-75a6-4c10-81d1-06f3503d7101.webp",
    moderationStatus: "pending",
    status: "inactive",
  });

  console.log("\n=======================================================");
  console.log("🚀 TEST 2 BAŞLADI: DÜZGÜN VİDEO (Kater vs Kater İcarəsi)");
  console.log("Video ID:", correctVideo._id.toString());
  console.log("=======================================================");

  analyzeVideoWithAI(correctVideo._id);

  console.log("\n⏳ AI analizinin nəticələri gözlənilir (Queue 2-2 emal edir)...");
  
  let attempts = 0;
  while (attempts < 25) {
    await new Promise((r) => setTimeout(r, 4000));
    attempts++;

    const v1 = await Video.findById(wrongVideo._id).lean();
    const v2 = await Video.findById(correctVideo._id).lean();

    if (v1 && v2 && v1.moderationStatus !== "pending" && v2.moderationStatus !== "pending") {
      console.log("\n=======================================================");
      console.log("🎉 HƏR İKİ TESTİN NƏTİCƏSİ ALINDI!");
      console.log("=======================================================");

      console.log("\n❌ TEST 1 (Uyğunsuz Kateqoriyalı Video):");
      console.log("Əsas Status (Feed görünürlük):", v1.status);
      console.log("Moderasiya Statusu:", v1.moderationStatus);
      console.log("AI Əminlik (Confidence):", v1.aiConfidence + "%");
      console.log("AI Rəyi / Səbəbi:", v1.aiFeedback);

      console.log("\n-------------------------------------------------------");

      console.log("\n✅ TEST 2 (Düzgün Kateqoriyalı Video):");
      console.log("Əsas Status (Feed görünürlük):", v2.status);
      console.log("Moderasiya Statusu:", v2.moderationStatus);
      console.log("AI Əminlik (Confidence):", v2.aiConfidence + "%");
      console.log("AI Rəyi / Səbəbi:", v2.aiFeedback);

      // Təmizlik
      await Video.deleteMany({ _id: { $in: [wrongVideo._id, correctVideo._id] } });
      await Category.deleteOne({ _id: matchingCategory._id });
      console.log("\n🧹 Test məlumatları bazadan təmizləndi.");

      process.exit(0);
    }
  }

  console.log("Timeout: Test vaxtı bitdi.");
  process.exit(1);
}

runTests().catch(console.error);
