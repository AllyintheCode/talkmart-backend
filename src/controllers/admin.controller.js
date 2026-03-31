import Onboarding from "../models/Onboarding.js";
import Category from "../models/Category.js";
import cloudinary from "../config/cloudinary.js";

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
