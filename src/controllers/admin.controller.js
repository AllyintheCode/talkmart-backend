import Onboarding from "../models/Onboarding.js";
import Category from "../models/Category.js";
import User from "../models/User.js";
import Video from "../models/Video.js";
import cloudinary from "../config/cloudinary.js";

// ============================
// DASHBOARD STATİSTİKALARI (ADMIN)
// ============================

export const getDashboardStats = async (req, res) => {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // 1. User Metrics
    const totalUsers = await User.countDocuments({ role: "user" });
    const totalProviders = await User.countDocuments({ role: "provider" });
    const newSignupsLast30Days = await User.countDocuments({
      createdAt: { $gte: thirtyDaysAgo }
    });

    // 2. Content & Activity Metrics
    const totalVideos = await Video.countDocuments();
    const activeCategories = await Category.countDocuments({ status: "active" });
    
    // Aggregation for total engagements
    const engagementStats = await Video.aggregate([
      {
        $group: {
          _id: null,
          totalViews: { $sum: "$viewCount" },
          totalLikes: { $sum: "$likeCount" },
          totalSaves: { $sum: "$saveCount" }
        }
      }
    ]);
    const totalEngagements = engagementStats[0] || { totalViews: 0, totalLikes: 0, totalSaves: 0 };

    // 3. Leaderboards
    // Top 5 Videos by Views
    const topVideos = await Video.find()
      .sort({ viewCount: -1 })
      .limit(5)
      .populate("providerId", "fullName email") // Şirkət adını gətirmək
      .select("title viewCount likeCount thumbnail providerId");

    // Top 5 Providers by uploaded videos
    const topProvidersAgg = await Video.aggregate([
      { $group: { _id: "$providerId", videoCount: { $sum: 1 } } },
      { $sort: { videoCount: -1 } },
      { $limit: 5 },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "provider"
        }
      },
      { $unwind: "$provider" },
      {
        $project: {
          _id: 1,
          videoCount: 1,
          fullName: "$provider.fullName",
          email: "$provider.email",
          companyName: "$provider.providerProfile.companyName"
        }
      }
    ]);

    return res.status(200).json({
      success: true,
      stats: {
        users: { totalUsers, totalProviders, newSignupsLast30Days },
        content: { totalVideos, activeCategories, totalEngagements },
        leaderboards: { topVideos, topProviders: topProvidersAgg }
      }
    });

  } catch (err) {
    console.error("getDashboardStats error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Server xətası." });
  }
};

// ============================
// CATEGORY İDARƏETMƏSİ (ADMIN)
// ============================

// Bütün kateqoriyaları gətir (Active + Inactive)
export const getAllCategories = async (req, res) => {
  try {
    const categories = await Category.find().sort({ createdAt: -1 });
    return res.status(200).json({ success: true, categories });
  } catch (err) {
    console.error("getAllCategories error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Server xətası." });
  }
};

// Yeni Kateqoriya yarat
export const createCategory = async (req, res) => {
  try {
    const { name, status } = req.body;
    
    if (!name || name.trim() === "") {
      return res.status(400).json({ error: "MISSING_NAME", message: "Kateqoriya adı tələb olunur." });
    }

    const existing = await Category.findOne({ name: name.trim() });
    if (existing) {
      return res.status(409).json({ error: "ALREADY_EXISTS", message: "Bu adda kateqoriya artıq mövcuddur." });
    }

    const category = await Category.create({ 
      name: name.trim(), 
      status: status || "active" 
    });

    return res.status(201).json({ success: true, message: "Kateqoriya yaradıldı", category });
  } catch (err) {
    console.error("createCategory error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Server xətası." });
  }
};

// Kateqoriyanı yenilə
export const updateCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, status } = req.body;

    const category = await Category.findById(id);
    if (!category) {
      return res.status(404).json({ error: "NOT_FOUND", message: "Kateqoriya tapılmadı." });
    }

    if (name) {
      // Başqa kateqoriya adı ilə çaxışırmı yoxla
      const existing = await Category.findOne({ name: name.trim(), _id: { $ne: id } });
      if (existing) {
         return res.status(409).json({ error: "ALREADY_EXISTS", message: "Bu adda başqa kateqoriya mövcuddur." });
      }
      category.name = name.trim();
    }
    
    if (status) {
      category.status = status;
    }

    await category.save();

    return res.status(200).json({ success: true, message: "Kateqoriya yeniləndi", category });
  } catch (err) {
    console.error("updateCategory error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Server xətası." });
  }
};

// Kateqoriyanı sil
export const deleteCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const category = await Category.findById(id);
    
    if (!category) {
      return res.status(404).json({ error: "NOT_FOUND", message: "Kateqoriya tapılmadı." });
    }

    await category.deleteOne();

    return res.status(200).json({ success: true, message: "Kateqoriya silindi." });
  } catch (err) {
    console.error("deleteCategory error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Server xətası." });
  }
};

// ============================
// ONBOARDING İDARƏETMƏSİ (ADMIN)
// ============================


// POST /api/admin/onboarding (Yalnız Admin)
export const createOnboarding = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "MISSING_FILE", message: "Şəkil faylı tələb olunur." });
    }

    const { title, description, order } = req.body;

    if (!title || !description) {
      // Əgər Cloudinary-yə yüklənmişdisə və xəta oldusa faylı silək
      if (req.file.filename) {
        await cloudinary.uploader.destroy(req.file.filename);
      }
      return res.status(400).json({ error: "MISSING_FIELDS", message: "Başlıq və açıqlama tələb olunur." });
    }

    const newScreen = await Onboarding.create({
      title,
      description,
      order: order ? parseInt(order) : 0,
      image: req.file.path, // Cloudinary secure_url
      publicId: req.file.filename,
    });

    return res.status(201).json({ success: true, message: "Onboarding ekranı yaradıldı.", screen: newScreen });
  } catch (err) {
    console.error("createOnboarding error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Server xətası." });
  }
};

// PUT /api/admin/onboarding/:id (Yalnız Admin)
export const updateOnboarding = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, order } = req.body;

    const screen = await Onboarding.findById(id);
    if (!screen) {
      return res.status(404).json({ error: "NOT_FOUND", message: "Ekran tapılmadı." });
    }

    // Əgər yeni şəkil göndərilibsə
    if (req.file) {
      // Köhnə şəkli silirik
      await cloudinary.uploader.destroy(screen.publicId);
      
      // Yeni şəkli mənimsədirik
      screen.image = req.file.path;
      screen.publicId = req.file.filename;
    }

    if (title) screen.title = title;
    if (description) screen.description = description;
    if (order !== undefined) screen.order = parseInt(order);

    await screen.save();

    return res.status(200).json({ success: true, message: "Onboarding ekranı yeniləndi.", screen });
  } catch (err) {
    console.error("updateOnboarding error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Server xətası." });
  }
};

// DELETE /api/admin/onboarding/:id (Yalnız Admin)
export const deleteOnboarding = async (req, res) => {
  try {
    const { id } = req.params;
    const screen = await Onboarding.findById(id);

    if (!screen) {
      return res.status(404).json({ error: "NOT_FOUND", message: "Ekran tapılmadı." });
    }

    // Cloudinary-dən şəkli silirik
    await cloudinary.uploader.destroy(screen.publicId);

    // Bazadan silirik
    await screen.deleteOne();

    return res.status(200).json({ success: true, message: "Onboarding ekranı silindi." });
  } catch (err) {
    console.error("deleteOnboarding error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Server xətası." });
  }
};

// ============================
// İSTİFADƏÇİ İDARƏETMƏSİ (ADMIN)
// ============================

// GET /api/admin/users (Yalnız Admin)
// Bütün istifadəçiləri limitsiz və filtersiz gətirir (Admin paneldəki modal üçün)
export const getAllUsers = async (req, res) => {
  try {
    const users = await User.find()
      .select("-password -__v")
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      count: users.length,
      users,
    });
  } catch (err) {
    console.error("getAllUsers error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Server xətası." });
  }
};

// ============================================================
// PATCH /api/admin/users/:id/block — İstifadəçini blokla
// ============================================================
export const blockUser = async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findById(id);

    if (!user) {
      return res.status(404).json({ error: "NOT_FOUND", message: "İstifadəçi tapılmadı." });
    }

    // Admini bloklamaq olmaz
    if (user.role === "admin") {
      return res.status(403).json({ error: "FORBIDDEN", message: "Admin hesabını bloklamaq mümkün deyil." });
    }

    if (user.isBlocked) {
      return res.status(409).json({ error: "ALREADY_BLOCKED", message: "İstifadəçi artıq bloklanıb." });
    }

    user.isBlocked = true;
    await user.save();

    return res.status(200).json({
      success: true,
      message: `${user.fullName} uğurla bloklandı.`,
    });
  } catch (err) {
    console.error("blockUser error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Server xətası." });
  }
};

// ============================================================
// PATCH /api/admin/users/:id/unblock — İstifadəçinin blokunu aç
// ============================================================
export const unblockUser = async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findById(id);

    if (!user) {
      return res.status(404).json({ error: "NOT_FOUND", message: "İstifadəçi tapılmadı." });
    }

    if (!user.isBlocked) {
      return res.status(409).json({ error: "NOT_BLOCKED", message: "İstifadəçi bloklanmayıb." });
    }

    user.isBlocked = false;
    await user.save();

    return res.status(200).json({
      success: true,
      message: `${user.fullName} uğurla blokdan çıxarıldı.`,
    });
  } catch (err) {
    console.error("unblockUser error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Server xətası." });
  }
};

// ============================================================
// DELETE /api/admin/users/:id — İstifadəçini sil
// ============================================================
export const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findById(id);

    if (!user) {
      return res.status(404).json({ error: "NOT_FOUND", message: "İstifadəçi tapılmadı." });
    }

    // Admini silmək olmaz
    if (user.role === "admin") {
      return res.status(403).json({ error: "FORBIDDEN", message: "Admin hesabını silmək mümkün deyil." });
    }

    // Əgər Cloudinary-də profil şəkli varsa, onu da sil
    if (user.profileImagePublicId) {
      try {
        await cloudinary.uploader.destroy(user.profileImagePublicId, { resource_type: "image" });
      } catch (cloudErr) {
        console.warn("Cloudinary profil şəkli silinərkən xəta:", cloudErr.message);
      }
    }

    await user.deleteOne();

    return res.status(200).json({
      success: true,
      message: `${user.fullName} hesabı uğurla silindi.`,
    });
  } catch (err) {
    console.error("deleteUser error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Server xətası." });
  }
};
