import mongoose from "mongoose";
import Video from "../models/Video.js";
import path from "path";
import fs from "fs";
import os from "os";
import crypto from "crypto";
import {
  VideoLike,
  VideoSave,
} from "../models/VideoInteraction.js";
import Category from "../models/Category.js";
import { deleteFromR2 } from "../services/r2Upload.service.js";
import { getVideoDuration } from "../services/compress.service.js";
import { enqueueVideoProcessing, getQueueStats } from "../services/videoProcessing.service.js";
import { validateVideoContentAI } from "../services/aiModeration.service.js";

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

    // Raw video buffer-i diskə tək dəfə yaz (Disk I/O optimallaşdırması)
    const tmpId = crypto.randomUUID();
    const tempFilePath = path.join(os.tmpdir(), `upload_${tmpId}${originalExt}`);
    fs.writeFileSync(tempFilePath, req.file.buffer);

    // Videonun uzunluğunu yoxla (Maks 5 dəqiqə = 300 saniyə)
    let duration = 0;
    try {
      duration = await getVideoDuration(tempFilePath, originalExt);
      if (duration > 300) {
        try { fs.unlinkSync(tempFilePath); } catch (_) {}
        return res.status(400).json({ error: "VIDEO_TOO_LONG", message: "Videonun uzunluğu 5 dəqiqədən artıq ola bilməz." });
      }
    } catch (durErr) {
      console.warn("Video uzunluğu yoxlanıla bilmədi:", durErr.message);
    }

    // Kateqoriyanı tap
    const category = await Category.findById(categoryId);
    if (!category) {
      try { if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); } catch (_) {}
      return res.status(404).json({ error: "CATEGORY_NOT_FOUND", message: "Seçilmiş kateqoriya tapılmadı." });
    }

    // ✅ DB-də qeyd yarat və FFMPEG + AI queue-suna ver
    const video = await Video.create({
      providerId: req.user._id,
      categoryId,
      title: title?.trim() || "",
      description: description.trim(),
      price: parsedPrice,
      videoUrl: "",       
      publicId: "",       
      thumbnail: "",
      duration: Math.round(duration || 0),
      moderationStatus: "pending", 
      aiFeedback: "",
      aiConfidence: 0,
      processingStatus: "queued",
      status: "inactive", 
    });

    // FFMPEG sıxışdırma, R2 upload və AI Moderasiyası eyni vaxtda başlayır
    enqueueVideoProcessing({
      videoId: video._id,
      tempFilePath,
      originalExt,
      categoryName: category.name,
      duration: Math.round(duration || 0),
    });

    const queueStats = getQueueStats();

    return res.status(201).json({
      success: true,
      message: "Video uğurla yükləndi və emal növbəsinə əlavə edildi.",
      video: {
        _id: video._id,
        providerId: video.providerId,
        categoryId: video.categoryId,
        title: video.title,
        description: video.description,
        price: video.price,
        processingStatus: video.processingStatus,
        moderationStatus: video.moderationStatus,
        status: video.status,
      },
      queue: {
        position: queueStats.queued,
        running: queueStats.running,
      }
    });
  } catch (err) {
    console.error("createVideo error:", err);
    if (err.name === "TimeoutError" || err.message?.includes("timeout")) {
      return res.status(408).json({ error: "NETWORK_ERROR", message: "Bağlantı zaman aşımına uğraudı." });
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
    let blockedIds = [];

    if (userId) {
      const User = (await import("../models/User.js")).default;
      const currentUser = await User.findById(userId);
      const blockers = await User.find({ blockedUsers: userId }).select("_id");
      blockedIds = [
        ...(currentUser?.blockedUsers || []),
        ...blockers.map(b => b._id)
      ];
    }

    const matchStage = { status: "active" };
    if (blockedIds.length > 0) {
      matchStage.providerId = { $nin: blockedIds };
    }

    const pipeline = [
      { $match: matchStage },
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

    let blockedIds = [];
    if (userId) {
      const User = (await import("../models/User.js")).default;
      const currentUser = await User.findById(userId);
      const blockers = await User.find({ blockedUsers: userId }).select("_id");
      blockedIds = [
        ...(currentUser?.blockedUsers || []),
        ...blockers.map(b => b._id)
      ];
    }

    const matchStage = { status: "active" };
    if (blockedIds.length > 0) {
      matchStage.providerId = { $nin: blockedIds };
    }


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
