import Onboarding from "../models/Onboarding.js";
import Category from "../models/Category.js";

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
