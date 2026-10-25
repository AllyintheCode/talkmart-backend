import Onboarding from "../models/Onboarding.js";
import Category from "../models/Category.js";
import Video from "../models/Video.js";
import { getCache, setCache } from "../config/redis.js";

// GET /api/onboarding
export const getOnboardings = async (req, res) => {
  try {
    const cached = await getCache("onboarding:screens");
    if (cached) {
      return res.status(200).json({ success: true, screens: cached });
    }

    const screens = await Onboarding.find().sort({ order: 1 });
    await setCache("onboarding:screens", screens, 3600); // 1 saat keş
    return res.status(200).json({ success: true, screens });
  } catch (err) {
    console.error("getOnboardings error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Server xətası." });
  }
};

// GET /api/categories
export const getActiveCategories = async (req, res) => {
  try {
    const cached = await getCache("categories:active");
    if (cached) {
      return res.status(200).json({ success: true, categories: cached });
    }

    const categories = await Category.find({ status: "active" }).sort({ name: 1 });
    await setCache("categories:active", categories, 3600); // 1 saat keş
    return res.status(200).json({ success: true, categories });
  } catch (err) {
    console.error("getActiveCategories error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Server xətası." });
  }
};

// GET /api/categories/top
// Ən çox istifadə olunan kateqoriyalar (aktiv video sayına görə azalan sıra)
export const getTopCategories = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const cacheKey = `categories:top:${limit}`;

    const cached = await getCache(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        count: cached.length,
        categories: cached,
      });
    }

    const topCategories = await Video.aggregate([
      // Yalnız aktiv videoları götür
      { $match: { status: "active" } },

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
    ]);

    await setCache(cacheKey, topCategories, 600); // 10 dəqiqə keş

    return res.status(200).json({
      success: true,
      count: topCategories.length,
      categories: topCategories,
    });
  } catch (err) {
    console.error("getTopCategories error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Server xətası." });
  }
};
