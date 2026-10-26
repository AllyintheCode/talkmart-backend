import { logger } from "../utils/logger.js";
import Onboarding from "../models/Onboarding.js";
import Category from "../models/Category.js";
import Video from "../models/Video.js";
import { getContentVersion } from "../services/publicContent.service.js";
import { parsePagination } from "../utils/pagination.js";
import { publicVideoFilter, publicOwnerFilter } from "../services/videoState.service.js";
import { getCache, setCache } from "../config/redis.js";

// GET /api/onboarding
export const getOnboardings = async (req, res) => {
  try {
    const contentVersion = await getContentVersion("onboarding");
    const key = `onboarding:screens:${contentVersion}`;
    const cached = await getCache(key);
    if (cached) {
      return res.status(200).json({ success: true, screens: cached, contentVersion });
    }

    const screens = await Onboarding.find().sort({ order: 1 });
    await setCache(key, screens, 3600); // 1 saat keş
    return res.status(200).json({ success: true, screens, contentVersion });
  } catch (err) {
    logger.error("getOnboardings error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Server xətası." });
  }
};

// GET /api/categories
export const getActiveCategories = async (req, res) => {
  try {
    const contentVersion = await getContentVersion("categories");
    const key = `categories:active:${contentVersion}`;
    const cached = await getCache(key);
    if (cached) {
      return res.status(200).json({ success: true, categories: cached, contentVersion });
    }

    const categories = await Category.find({ status: "active" }).sort({ name: 1 });
    await setCache(key, categories, 3600); // 1 saat keş
    return res.status(200).json({ success: true, categories, contentVersion });
  } catch (err) {
    logger.error("getActiveCategories error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Server xətası." });
  }
};

// GET /api/categories/top
// Ən çox istifadə olunan kateqoriyalar (aktiv video sayına görə azalan sıra)
export const getTopCategories = async (req, res) => {
  try {
    const { limit } = parsePagination(req.query, { limit: 10 });
    const contentVersion = await getContentVersion("categories");
    const topCategories = await Video.aggregate([
      // Yalnız aktiv videoları götür
      { $match: publicVideoFilter() },
      { $lookup: { from: "users", localField: "providerId", foreignField: "_id", as: "provider" } },
      { $unwind: "$provider" },
      { $match: publicOwnerFilter() },

      // Kateqoriyaya görə qruplaşdır və video sayını hesabla
      {
        $group: {
          _id: "$categoryId",
          videoCount: { $sum: 1 },
        },
      },

      // Kateqoriya məlumatlarını birləşdir
      {
        $lookup: {
          from: "categories",
          localField: "_id",
          foreignField: "_id",
          as: "category",
        },
      },
      { $unwind: "$category" },

      // Yalnız aktiv kateqoriyaları göstər
      { $match: { "category.status": "active" } },

      // Video sayına görə azalan sıra
      { $sort: { videoCount: -1 } },

      // Limit tətbiq et
      { $limit: limit },

      // Cavab formatı
      {
        $project: {
          _id: 0,
          categoryId: "$_id",
          name: "$category.name",
          videoCount: 1,
        },
      },
    ]).option({ maxTimeMS: 5000 });


    return res.status(200).json({
      success: true,
      count: topCategories.length,
      categories: topCategories,
    });
  } catch (err) {
    logger.error("getTopCategories error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Server xətası." });
  }
};
