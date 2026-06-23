import Onboarding from "../models/Onboarding.js";
import Category from "../models/Category.js";
import Video from "../models/Video.js";

// GET /api/onboarding
export const getOnboardings = async (req, res) => {
  try {
    const screens = await Onboarding.find().sort({ order: 1 });
    return res.status(200).json({ success: true, screens });
  } catch (err) {
    console.error("getOnboardings error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Server xətası." });
  }
};

// GET /api/categories
export const getActiveCategories = async (req, res) => {
  try {
    const categories = await Category.find({ status: "active" }).sort({ name: 1 });
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
