import mongoose from "mongoose";
import Video from "../models/Video.js";
import path from "path";
import {
  VideoLike,
  VideoSave,
} from "../models/VideoInteraction.js";
import { uploadToR2, deleteFromR2 } from "../services/r2Upload.service.js";
import { compressVideo } from "../services/compress.service.js";

// POST /api/videos/upload
export const createVideo = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "MISSING_FILE", message: "Video fayl tələb olunur." });
    }

    const { description, price, title, categoryId } = req.body;

    if (!categoryId) {
      return res.status(400).json({ error: "MISSING_CATEGORY", message: "Kateqoriya seçimi tələb olunur." });
    }

    if (!description || description.trim() === "") {
      return res.status(400).json({ error: "MISSING_DESCRIPTION", message: "Açıqlama tələb olunur." });
    }

    if (price === undefined || price === null || price === "") {
      return res.status(400).json({ error: "MISSING_PRICE", message: "Qiymət tələb olunur." });
    }

    const parsedPrice = parseFloat(price);
    if (isNaN(parsedPrice) || parsedPrice < 0) {
      return res.status(400).json({ error: "INVALID_PRICE", message: "Qiymət düzgün deyil." });
    }

    // Video faylının uzantısını təyin et
    const originalExt = path.extname(req.file.originalname).toLowerCase() || ".mp4";
    const originalSize = req.file.buffer.length;

    // ✅ Video sıxışdırma (H.264, CRF 23 — göz fərq etmir, ölçü ~50% azalır)
    const compressed = await compressVideo(req.file.buffer, originalExt);
    const compressedSize = compressed.buffer.length;
    const savedPercent = ((1 - compressedSize / originalSize) * 100).toFixed(1);
    console.log(`📦 Video sıxışdırma: ${(originalSize / 1024 / 1024).toFixed(2)}MB → ${(compressedSize / 1024 / 1024).toFixed(2)}MB (${savedPercent}% azalma)`);

    // R2-yə sıxışdırılmış video yüklə
    const { key: videoKey, url: videoUrl } = await uploadToR2(
      compressed.buffer,
      "talkmart/videos",
      compressed.mimetype,
      compressed.ext
    );

    // Thumbnail — R2-də video URL-indən frame göstərmək mümkün deyil,
    // ona görə boş saxlayırıq (mobil tərəfdə ilk frame istifadə oluna bilər)
    const thumbnail = "";

    const video = await Video.create({
      providerId: req.user._id,
      categoryId,
      title: title?.trim() || "",
      description: description.trim(),
      price: parsedPrice,
      videoUrl,
      publicId: videoKey, // R2 key saxlanılır (silmək üçün)
      thumbnail,
      duration: 0,
    });

    return res.status(201).json({
      success: true,
      message: "Video uğurla yükləndi.",
      video,
    });
  } catch (err) {
    console.error("createVideo error:", err);
    if (err.name === "TimeoutError" || err.message.includes("timeout")) {
      return res.status(408).json({ error: "NETWORK_ERROR", message: "Bağlantı zaman aşımına uğradı." });
    }
    return res.status(500).json({ error: "SERVER_ERROR", message: "Server xətası baş verdi. Zəhmət olmasa yenidən cəhd edin." });
  }
};

// GET /api/videos/my-videos
export const getMyVideos = async (req, res) => {
  try {
    const videos = await Video.find({ providerId: req.user._id }).sort({
      createdAt: -1,
    });

    return res.status(200).json({
      success: true,
      count: videos.length,
      videos,
    });
  } catch (err) {
    console.error("getMyVideos error:", err);
    return res.status(500).json({ message: "Server xətası." });
  }
};

// DELETE /api/videos/:id
export const deleteVideo = async (req, res) => {
  try {
    const video = await Video.findOne({
      _id: req.params.id,
      providerId: req.user._id,
    });

    if (!video) {
      return res.status(404).json({ message: "Video tapılmadı." });
    }

    // R2-dən video faylını sil
    await deleteFromR2(video.publicId);

    // Əgər thumbnail varsa onu da sil
    if (video.thumbnail) {
      // Thumbnail key-ni URL-dən çıxar
      try {
        const thumbUrl = new URL(video.thumbnail);
        const thumbKey = thumbUrl.pathname.replace(/^\//, "");
        await deleteFromR2(thumbKey);
      } catch (_) {
        // thumbnail URL parse olunmazsa keç
      }
    }

    await video.deleteOne();

    return res.status(200).json({
      success: true,
      message: "Video silindi.",
    });
  } catch (err) {
    console.error("deleteVideo error:", err);
    return res.status(500).json({ message: "Server xətası." });
  }
};

// ============================
// PUBLIC / EXPLORE FEED ROUTES
// ============================

// GET /api/videos/feed
// Home (Reels) Məntiqi: Formatlandıırılmış təsadüfi axın (Yalnız status="active")
// BİRLƏŞDİRİLMİŞ API: provider phone, likeCount, saveCount, isLiked, isSaved hamısı bir response-da
export const getFeedVideos = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const userId = req.user?._id || null;

    const pipeline = [
      { $match: { status: "active" } },
      { $sample: { size: limit } },
      // Provider məlumatları — fullName, companyName, phone
      {
        $lookup: {
          from: "users",
          localField: "providerId",
          foreignField: "_id",
          as: "provider",
        },
      },
      { $unwind: "$provider" },
    ];

    // Login olmuş istifadəçi üçün isLiked / isSaved əlavə et
    if (userId) {
      pipeline.push(
        // Like yoxla
        {
          $lookup: {
            from: "videolikes",
            let: { vid: "$_id" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ["$videoId", "$$vid"] },
                      { $eq: ["$userId", new mongoose.Types.ObjectId(userId)] },
                    ],
                  },
                },
              },
              { $limit: 1 },
            ],
            as: "userLike",
          },
        },
        // Save yoxla
        {
          $lookup: {
            from: "videosaves",
            let: { vid: "$_id" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ["$videoId", "$$vid"] },
                      { $eq: ["$userId", new mongoose.Types.ObjectId(userId)] },
                    ],
                  },
                },
              },
              { $limit: 1 },
            ],
            as: "userSave",
          },
        }
      );
    }

    // Final projection
    pipeline.push({
      $project: {
        _id: 1,
        title: 1,
        description: 1,
        price: 1,
        videoUrl: 1,
        thumbnail: 1,
        categoryId: 1,
        duration: 1,
        likeCount: 1,
        viewCount: 1,
        saveCount: 1,
        createdAt: 1,
        provider: {
          _id: "$provider._id",
          fullName: "$provider.fullName",
          companyName: "$provider.providerProfile.companyName",
          phone: "$provider.phone",
          address: "$provider.providerProfile.address",
          profileImage: "$provider.profileImage",
        },
        isLiked: userId
          ? { $gt: [{ $size: "$userLike" }, 0] }
          : { $literal: false },
        isSaved: userId
          ? { $gt: [{ $size: "$userSave" }, 0] }
          : { $literal: false },
      },
    });

    const videos = await Video.aggregate(pipeline);

    return res.status(200).json({ success: true, count: videos.length, videos });
  } catch (err) {
    console.error("getFeedVideos error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Server xətası." });
  }
};

// GET /api/videos/explore
// Explore (Axtarış / Filtrləmə) Məntiqi: Səhifələmə (Pagination), Kateqoriya filteri
// BİRLƏŞDİRİLMİŞ API: provider phone, isLiked, isSaved hamısı bir response-da
export const getExploreVideos = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 15;
    const skip = (page - 1) * limit;
    const userId = req.user?._id || null;

    const { categoryId, search, sort, location, minPrice, maxPrice } = req.query;

    const matchStage = { status: "active" };

    // Kateqoriya filteri
    if (categoryId) {
      matchStage.categoryId = new mongoose.Types.ObjectId(String(categoryId));
    }

    // Ad / açıqlama axtarışı
    if (search) {
      const safeSearch = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const searchRegex = new RegExp(safeSearch, "i");
      matchStage.$or = [{ title: searchRegex }, { description: searchRegex }];
    }

    // Qiymət aralığı filteri
    if (minPrice !== undefined || maxPrice !== undefined) {
      matchStage.price = {};
      if (minPrice !== undefined && !isNaN(parseFloat(minPrice))) {
        matchStage.price.$gte = parseFloat(minPrice);
      }
      if (maxPrice !== undefined && !isNaN(parseFloat(maxPrice))) {
        matchStage.price.$lte = parseFloat(maxPrice);
      }
    }

    let sortOption = { createdAt: -1 }; // default: ən yenilər
    if (sort === "trending") sortOption = { viewCount: -1, likeCount: -1 };
    else if (sort === "price_low") sortOption = { price: 1 };
    else if (sort === "price_high") sortOption = { price: -1 };

    const basePipeline = [
      { $match: matchStage },
      // Provider məlumatları — fullName, companyName, phone, address
      {
        $lookup: {
          from: "users",
          localField: "providerId",
          foreignField: "_id",
          as: "provider",
        },
      },
      { $unwind: "$provider" },
    ];

    // Location filteri — provider-in address-inə görə filtrləyirik
    if (location) {
      const safeLocation = String(location).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const locationRegex = new RegExp(safeLocation, "i");
      basePipeline.push({
        $match: { "provider.providerProfile.address": locationRegex },
      });
    }

    const dataPipeline = [
      { $sort: sortOption },
      { $skip: skip },
      { $limit: limit },
    ];

    // Login olmuş istifadəçi üçün isLiked / isSaved əlavə et
    if (userId) {
      dataPipeline.push(
        {
          $lookup: {
            from: "videolikes",
            let: { vid: "$_id" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ["$videoId", "$$vid"] },
                      { $eq: ["$userId", new mongoose.Types.ObjectId(userId)] },
                    ],
                  },
                },
              },
              { $limit: 1 },
            ],
            as: "userLike",
          },
        },
        {
          $lookup: {
            from: "videosaves",
            let: { vid: "$_id" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ["$videoId", "$$vid"] },
                      { $eq: ["$userId", new mongoose.Types.ObjectId(userId)] },
                    ],
                  },
                },
              },
              { $limit: 1 },
            ],
            as: "userSave",
          },
        }
      );
    }

    // Final projection — publicId göndərmirik
    dataPipeline.push({
      $project: {
        _id: 1,
        title: 1,
        description: 1,
        price: 1,
        videoUrl: 1,
        thumbnail: 1,
        categoryId: 1,
        duration: 1,
        likeCount: 1,
        viewCount: 1,
        saveCount: 1,
        createdAt: 1,
        provider: {
          _id: "$provider._id",
          fullName: "$provider.fullName",
          companyName: "$provider.providerProfile.companyName",
          phone: "$provider.phone",
          address: "$provider.providerProfile.address",
          profileImage: "$provider.profileImage",
        },
        isLiked: userId
          ? { $gt: [{ $size: "$userLike" }, 0] }
          : { $literal: false },
        isSaved: userId
          ? { $gt: [{ $size: "$userSave" }, 0] }
          : { $literal: false },
      },
    });

    basePipeline.push({
      $facet: {
        metadata: [{ $count: "total" }],
        data: dataPipeline,
      },
    });

    const result = await Video.aggregate(basePipeline);
    const total = result[0]?.metadata[0]?.total || 0;
    const videos = result[0]?.data || [];

    return res.status(200).json({
      success: true,
      count: videos.length,
      total,
      page,
      totalPages: Math.ceil(total / limit),
      videos,
    });
  } catch (err) {
    console.error("getExploreVideos error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Server xətası." });
  }
};
