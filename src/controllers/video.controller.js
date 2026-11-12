import { logger } from "../utils/logger.js";
import mongoose from "mongoose";
import Video from "../models/Video.js";
import path from "path";
import crypto from "node:crypto";
import fs from "fs";
import Category from "../models/Category.js";
import { uploadFileToR2 } from "../services/r2Upload.service.js";
import { getQueueStats } from "../services/videoProcessing.service.js";
import { validateUploadedVideo } from "../services/mediaProbe.service.js";
import { deleteVideoCompletely } from "../services/videoCleanup.service.js";
import { parsePagination, isValidObjectId, cursorFilter, nextCursor } from "../utils/pagination.js";
import { observe } from "../utils/metrics.js";
import { publicVideoFilter, publicOwnerFilter } from "../services/videoState.service.js";
import { fail } from "../utils/http.js";
import { videoForViewer } from "../services/videoMedia.service.js";

const unlinkQuiet = (filePath) => {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (_) {}
};

const providerPublicFields = () => ({
  _id: "$provider._id",
  fullName: "$provider.fullName",
  companyName: "$provider.providerProfile.companyName",
  profileImage: "$provider.profileImage",

});

// POST /api/videos/upload
export const createVideo = async (req, res) => {
  const tempFilePath = req.file?.path || null;
  let pendingVideo;
  const started = Date.now();

  try {
    if (!req.file) {
      return fail(res, 400, "MISSING_FILE", "Video fayl tələb olunur.");
    }

    const { description, price, title, categoryId } = req.body;

    if (!categoryId) {
      return fail(res, 400, "MISSING_CATEGORY", "Kateqoriya seçimi tələb olunur.");
    }
    if (!isValidObjectId(categoryId)) {
      return fail(res, 400, "INVALID_CATEGORY", "Kateqoriya ID formatı yanlışdır.");
    }
    if (typeof description !== "string" || description.trim() === "" || description.length > 5000) {
      return fail(res, 400, "MISSING_DESCRIPTION", "Açıqlama tələb olunur.");
    }
    if (price === undefined || price === null || price === "") {
      return fail(res, 400, "MISSING_PRICE", "Qiymət tələb olunur.");
    }

    const parsedPrice = Number(price);
    if (!Number.isFinite(parsedPrice) || parsedPrice < 0) {
      return fail(res, 400, "INVALID_PRICE", "Qiymət düzgün deyil.");
    }

    const originalExt = path.extname(req.file.originalname).toLowerCase() || ".mp4";
    let probe;
    try {
      probe = await validateUploadedVideo(tempFilePath);
    } catch (probeErr) {
      const map = {
        VIDEO_TOO_LONG: [400, "Videonun uzunluğu 5 dəqiqədən artıq ola bilməz."],
        VIDEO_RESOLUTION_TOO_HIGH: [400, "Video qətnaməsi çox yüksəkdir."],
        CORRUPT_VIDEO: [400, "Video faylı zədəlidir və ya oxuna bilmir."],
        UNSUPPORTED_FORMAT: [415, "Dəstəklənməyən media formatı."],
      };
      const mapped = map[probeErr.code] || [400, "Video yoxlanışı uğursuz oldu."];
      return fail(res, mapped[0], probeErr.code || "INVALID_VIDEO", mapped[1]);
    }

    const category = await Category.findById(categoryId);
    if (!category || category.status !== "active") {
      return fail(res, 404, "CATEGORY_NOT_FOUND", "Seçilmiş kateqoriya tapılmadı.");
    }

    if (typeof title !== "undefined" && (typeof title !== "string" || title.length > 200)) return fail(res, 400, "INVALID_TITLE", "Invalid title");
    const stagingKey = `talkmart/staging/${req.user._id}/${crypto.randomUUID()}${originalExt}`;
    const video = pendingVideo = await Video.create({
      providerId: req.user._id,
      categoryId,
      title: title?.trim() || "",
      description: description.trim(),
      price: parsedPrice,
      videoUrl: "",
      publicId: "",
      thumbnail: "",
      duration: probe.duration,
      moderationStatus: "pending",
      moderationSource: null,
      decisionVersion: 1,
      aiFeedback: "",
      aiConfidence: 0,
      processingStatus: "uploaded",
      status: "inactive",
      stagingKey,
      categoryName: category.name,
      sourceBytes: req.file.size,
      uploadId: req.uploadId,
      originalExt,
    });

    await uploadFileToR2(tempFilePath, "talkmart/staging", req.file.mimetype || "video/mp4", originalExt, stagingKey);
    video.processingStatus = "queued";
    await video.save();
    pendingVideo = null;
    observe("upload_ack_ms", Date.now() - started);
    const queueStats = await getQueueStats();
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
      },
    });
  } catch (err) {
    logger.error("createVideo error:", err);
    if (err.name === "TimeoutError" || err.message?.includes("timeout")) {
      return fail(res, 408, "NETWORK_ERROR", "Bağlantı zaman aşımına uğraudı.");
    }
    return fail(res, 500, "SERVER_ERROR", "Server xətası baş verdi. Zəhmət olmasa yenidən cəhd edin.");
  } finally {
    unlinkQuiet(tempFilePath);
    if (pendingVideo) await Video.updateOne({ _id: pendingVideo._id }, { $set: { status: "deleting", processingStatus: "deleting" } });
    await req.releaseUpload?.();
  }
};

// GET /api/videos/my-videos
export const getMyVideos = async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const videos = await Video.find({ providerId: req.user._id, status: { $ne: "deleting" }, ...cursorFilter(req.query.cursor) }).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).maxTimeMS(5000);
    res.setHeader("Cache-Control", "private, no-store");
    return res.status(200).json({
      success: true,
      count: videos.length,
      videos: await Promise.all(videos.map(video => videoForViewer(video, req.user))), page, nextCursor: nextCursor(videos, limit),
    });
  } catch (err) {
    logger.error("getMyVideos error:", err);
    return res.status(500).json({ message: "Server xətası." });
  }
};

// DELETE /api/videos/:id
export const deleteVideo = async (req, res) => {
  try {
    const deleted = await deleteVideoCompletely(req.params.id, { providerId: req.user._id });
    if (!deleted) {
      return fail(res, 404, "NOT_FOUND", "Video tapılmadı.");
    }
    return res.status(200).json({
      success: true,
      message: "Video silindi.",
    });
  } catch (err) {
    logger.error("deleteVideo error:", err);
    return fail(res, 500, "SERVER_ERROR", "Server xətası.");
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
    let limit;
    try {
      ({ limit } = parsePagination(req.query, { limit: 10 }));
    } catch (e) {
      return fail(res, 400, e.code || "INVALID_PAGINATION", e.message);
    }
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

    const matchStage = publicVideoFilter();
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
      { $match: publicOwnerFilter() },
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
        provider: providerPublicFields(Boolean(userId)),
        isLiked: userId
          ? { $gt: [{ $size: "$userLike" }, 0] }
          : { $literal: false },
        isSaved: userId
          ? { $gt: [{ $size: "$userSave" }, 0] }
          : { $literal: false },
      },
    });

    const videos = await Video.aggregate(pipeline).option({ maxTimeMS: 5000 });

    return res.status(200).json({ success: true, count: videos.length, videos });
  } catch (err) {
    logger.error("getFeedVideos error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Server xətası." });
  }
};

// GET /api/videos/explore
// Explore (Axtarış / Filtrləmə) Məntiqi: Səhifələmə (Pagination), Kateqoriya filteri
// BİRLƏŞDİRİLMİŞ API: provider phone, isLiked, isSaved hamısı bir response-da
export const getExploreVideos = async (req, res) => {
  try {
    let page, limit, skip;
    try {
      ({ page, limit, skip } = parsePagination(req.query, { limit: 15 }));
    } catch (e) {
      return fail(res, 400, e.code || "INVALID_PAGINATION", e.message);
    }
    const userId = req.user?._id || null;

    const { categoryId, search, sort, location, minPrice, maxPrice } = req.query;
    const { providerId } = req.query;
    if (providerId !== undefined && !isValidObjectId(providerId)) {
      return fail(res, 400, "INVALID_PROVIDER", "Provider ID formatı yanlışdır.");
    }

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

    const matchStage = { ...publicVideoFilter(), ...cursorFilter(req.query.cursor) };
    if (matchStage.$or) matchStage.$or[1]._id.$lt = new mongoose.Types.ObjectId(matchStage.$or[1]._id.$lt);
    if (providerId || blockedIds.length > 0) {
      matchStage.providerId = {
        ...(providerId ? { $eq: new mongoose.Types.ObjectId(String(providerId)) } : {}),
        ...(blockedIds.length > 0 ? { $nin: blockedIds } : {}),
      };
    }


    // Kateqoriya filteri
    if (categoryId) {
      if (!isValidObjectId(categoryId)) {
        return fail(res, 400, "INVALID_CATEGORY", "Kateqoriya ID formatı yanlışdır.");
      }
      matchStage.categoryId = new mongoose.Types.ObjectId(String(categoryId));
    }

    // Ad / açıqlama axtarışı
    if (search) matchStage.$text = { $search: search };

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

    let sortOption = { createdAt: -1, _id: -1 }; // default: ən yenilər
    if (sort === "trending") sortOption = { viewCount: -1, likeCount: -1 };
    else if (sort === "price_low") sortOption = { price: 1, _id: -1 };
    else if (sort === "price_high") sortOption = { price: -1, _id: -1 };

    const ownerStages = [
      {
        $lookup: {
          from: "users",
          localField: "providerId",
          foreignField: "_id",
          as: "provider",
        },
      },
      { $unwind: "$provider" },
      { $match: publicOwnerFilter() },
    ];

    // Location filteri — provider-in address-inə görə filtrləyirik
    let locationRegex;
    if (location) {
      const safeLocation = String(location).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      locationRegex = new RegExp(safeLocation, "i");
      ownerStages.push({
        $match: { "provider.providerProfile.address": locationRegex },
      });
    }

    // Count videos per owner before joining users. A bounded owner set avoids a large $in query.
    const ownerCounts = await Video.aggregate([
      { $match: matchStage }, { $group: { _id: "$providerId", count: { $sum: 1 } } }, { $limit: 1001 },
    ]).option({ maxTimeMS: 5000 });
    const boundedOwners = ownerCounts.length <= 1000;
    let fastTotal = 0;
    if (boundedOwners) {
      const User = (await import("../models/User.js")).default;
      const typedOwners = ownerCounts.filter(owner => owner._id instanceof mongoose.Types.ObjectId);
      const eligibleOwners = await User.find({ _id: { $in: typedOwners.map(owner => owner._id) }, ...publicOwnerFilter(""),
        ...(locationRegex ? { "providerProfile.address": locationRegex } : {}) }).select("_id").lean().maxTimeMS(5000);
      const eligible = new Set(eligibleOwners.map(owner => String(owner._id)));
      fastTotal = typedOwners.filter(owner => eligible.has(String(owner._id))).reduce((sum, owner) => sum + owner.count, 0);
      matchStage.providerId = { $in: eligibleOwners.map(owner => owner._id) };
    }
    const basePipeline = [{ $match: matchStage }, ...(boundedOwners ? [] : ownerStages)];

    const dataPipeline = [
      { $sort: sortOption },
      { $skip: skip },
      { $limit: limit },
      // Recheck live owner visibility after paging even on the bounded fast path.
      ...(boundedOwners ? ownerStages : []),
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
        provider: providerPublicFields(Boolean(userId)),
        isLiked: userId
          ? { $gt: [{ $size: "$userLike" }, 0] }
          : { $literal: false },
        isSaved: userId
          ? { $gt: [{ $size: "$userSave" }, 0] }
          : { $literal: false },
      },
    });

    let videos, total;
    if (boundedOwners) {
      total = fastTotal;
      videos = total ? await Video.aggregate([...basePipeline, ...dataPipeline]).option({ maxTimeMS: 5000 }) : [];
    } else {
      const result = await Video.aggregate([...basePipeline, { $facet: { metadata: [{ $count: "total" }], data: dataPipeline } }]).option({ maxTimeMS: 5000 });
      total = result[0]?.metadata[0]?.total || 0;
      videos = result[0]?.data || [];
    }

    return res.status(200).json({
      success: true,
      count: videos.length,
      total,
      page,
      totalPages: Math.ceil(total / limit),
      nextCursor: !sort || sort === "newest" ? nextCursor(videos, limit) : null,
      videos,
    });
  } catch (err) {
    logger.error("getExploreVideos error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Server xətası." });
  }
};

// GET /api/videos/:id/public — Deep link fallback səhifəsi üçün ictimai video məlumatı
export const getPublicVideoById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: "NOT_FOUND", message: "Video tapılmadı." });
    }

    const video = await Video.findOne({ _id: id, ...publicVideoFilter() })
      .populate("providerId", "isBlocked accountStatus emailVerified")
      .select("title description thumbnail videoUrl duration viewCount likeCount createdAt providerId")
      .lean();

    if (!video || !video.providerId || video.providerId.isBlocked || video.providerId.accountStatus === "deleting" || !video.providerId.emailVerified) {
      return res.status(404).json({ error: "NOT_FOUND", message: "Video tapılmadı və ya aktiv deyil." });
    }

    delete video.providerId;
    return res.status(200).json({ success: true, video });
  } catch (err) {
    logger.error("getPublicVideoById error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Server xətası." });
  }
};
