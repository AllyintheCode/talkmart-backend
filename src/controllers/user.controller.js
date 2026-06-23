import User from "../models/User.js";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import path from "path";
import Otp from "../models/Otp.js";
import { sendEmailOtp } from "../utils/email.js";
import { uploadToR2, deleteFromR2 } from "../services/r2Upload.service.js";
import { compressImage } from "../services/compress.service.js";

// checkAndHashPassword funksiyası silinib, çünki şifrə yenilənməsi ayrıca API-də (changePassword) edilir.

// GET /api/users/user
// Yalnız asan (adi) istifadəçilərin (User) məlumatlarını gətirir
export const getUserProfile = async (req, res) => {
  try {
    const userId = req.user._id;
    const user = await User.findById(userId).select("-password -__v");
    
    if (!user) {
      return res.status(404).json({ message: "İstifadəçi tapılmadı." });
    }
    
    if (user.role !== "user") {
      return res.status(403).json({ message: "Bu API yalnız adi istifadəçilər üçündür." });
    }
    
    return res.json({
      success: true,
      user,
    });
  } catch (err) {
    console.error("getUserProfile error:", err);
    return res.status(500).json({ message: "Server xətası baş verdi." });
  }
};

// GET /api/users/provider
// Xidmət Təminatçısı (Provider) məlumatlarını gətirir
export const getProviderProfile = async (req, res) => {
  try {
    const userId = req.user._id;
    const provider = await User.findById(userId).select("-password -__v");
    
    if (!provider) {
      return res.status(404).json({ message: "Provider tapılmadı." });
    }
    
    if (provider.role !== "provider") {
      return res.status(403).json({ message: "Bu API yalnız providerlər üçündür." });
    }
    
    return res.json({
      success: true,
      provider,
    });
  } catch (err) {
    console.error("getProviderProfile error:", err);
    return res.status(500).json({ message: "Server xətası baş verdi." });
  }
};

// PUT /api/users/change-password
// Cari şifrəni təsdiqləyərək yeni şifrə təyin etmək
export const changePassword = async (req, res) => {
  try {
    const userId = req.user._id;
    const { currentPassword, newPassword, confirmPassword } = req.body;

    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ message: "Bütün sahələri (currentPassword, newPassword, confirmPassword) daxil edin." });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ message: "Yeni şifrələr uyğun gəlmir." });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "İstifadəçi tapılmadı." });
    }

    // Mövcud şifrəni yoxla
    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Cari şifrə yanlışdır." });
    }

    // Yeni şifrəni heşlə və yadda saxla
    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);
    
    await user.save();

    return res.json({
      success: true,
      message: "Şifrəniz uğurla yeniləndi.",
    });
  } catch (err) {
    console.error("changePassword error:", err);
    return res.status(500).json({ message: "Server xətası baş verdi." });
  }
};

/**
 * Profil şəklini R2-yə yükləyib user-i yeniləyən köməkçi funksiya
 * Əvvəlki şəkli R2-dən silir, yenisini yükləyir
 */
const handleProfileImageUpload = async (user, file) => {
  // Köhnə şəkli sil
  if (user.profileImagePublicId) {
    try {
      await deleteFromR2(user.profileImagePublicId);
    } catch (err) {
      console.warn("R2 köhnə profil şəkli silinərkən xəta:", err.message);
    }
  }

  const originalSize = file.buffer.length;
  const compressed = await compressImage(file.buffer);
  const compressedSize = compressed.buffer.length;
  const savedPercent = ((1 - compressedSize / originalSize) * 100).toFixed(1);
  console.log(`🖼️ Şəkil sıxışdırma: ${(originalSize / 1024).toFixed(2)}KB → ${(compressedSize / 1024).toFixed(2)}KB (${savedPercent}% azalma)`);

  const { key, url } = await uploadToR2(compressed.buffer, "talkmart/images", compressed.mimetype, compressed.ext);
  user.profileImage = url;
  user.profileImagePublicId = key;
};

// PUT /api/users/user
// Yalnız asan (adi) istifadəçilərin (User) məlumatlarını yeniləyir
export const updateUser = async (req, res) => {
  try {
    const userId = req.user._id;
    const { fullName, email, bio, phone } = req.body;

    const user = await User.findById(userId);
    let emailVerificationSent = false;
    if (!user) {
      return res.status(404).json({ message: "İstifadəçi tapılmadı." });
    }
    
    // Yalnız adi 'user' hesabı üçün
    if (user.role !== "user") {
      return res.status(403).json({ message: "Bu API yalnız adi istifadəçilər üçündür." });
    }

    // Əgər e-poçt dəyişirsə, yoxlayaq ki, digər istifadəçi eyni emaili tutmayıb
    if (email && email !== user.email) {
      const emailExists = await User.findOne({ email });
      if (emailExists) {
        return res.status(409).json({ message: "Bu E-poçt ünvanı artıq istifadə olunur." });
      }
      
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const otpHash = crypto.createHash("sha256").update(code).digest("hex");
      
      await Otp.findOneAndUpdate(
        { email: user.email, purpose: "email_change" },
        {
          otpHash,
          newEmail: email,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
          attemptsLeft: 5,
          lastSentAt: new Date(),
        },
        { upsert: true }
      );
      
      await sendEmailOtp(user.email, code, "email_change");
      emailVerificationSent = true;
    }

    // Telefon yeniləməsi
    if (phone && phone !== user.phone) {
      const phoneExists = await User.findOne({ phone });
      if (phoneExists) {
        return res.status(409).json({ message: "Bu telefon nömrəsi artıq istifadə olunur." });
      }
      user.phone = phone;
    }

    // AdSoyad yeniləməsi
    if (fullName !== undefined) user.fullName = fullName;
    if (bio !== undefined) user.bio = bio;

    // Profil şəkli yenilənməsi
    if (req.file) {
      await handleProfileImageUpload(user, req.file);
    } else if (req.body.profileImage !== undefined) {
      user.profileImage = req.body.profileImage;
    }
    await user.save();

    // Cavab (Response) qaytararkən şifrələri gizlət
    const updatedUser = user.toObject();
    delete updatedUser.password;
    delete updatedUser.__v;

    return res.json({
      success: true,
      message: emailVerificationSent 
        ? "Profiliniz yeniləndi. Email dəyişikliyi üçün köhnə emailinizə təsdiq kodu göndərildi." 
        : "İstifadəçi profiliniz uğurla yeniləndi.",
      user: updatedUser,
      requiresEmailVerification: emailVerificationSent,
    });
  } catch (err) {
    console.error("updateUser error:", err);
    return res.status(500).json({ message: "Server xətası baş verdi." });
  }
};

// POST /api/users/profile
// Adi istifadəçilərin (User) məlumatlarını, bio və şəkilini yeniləyir
export const updateUserProfile = async (req, res) => {
  try {
    const userId = req.user._id;
    const { fullName, email, bio, phone } = req.body;

    const user = await User.findById(userId);
    let emailVerificationSent = false;
    if (!user) {
      return res.status(404).json({ message: "İstifadəçi tapılmadı." });
    }
    
    // Yalnız adi 'user' hesabı üçün
    if (user.role !== "user") {
      return res.status(403).json({ message: "Bu API yalnız adi istifadəçilər üçündür." });
    }

    if (email && email !== user.email) {
      const emailExists = await User.findOne({ email });
      if (emailExists) {
        return res.status(409).json({ message: "Bu E-poçt ünvanı artıq istifadə olunur." });
      }

      const code = String(Math.floor(100000 + Math.random() * 900000));
      const otpHash = crypto.createHash("sha256").update(code).digest("hex");
      
      await Otp.findOneAndUpdate(
        { email: user.email, purpose: "email_change" },
        {
          otpHash,
          newEmail: email,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
          attemptsLeft: 5,
          lastSentAt: new Date(),
        },
        { upsert: true }
      );
      
      await sendEmailOtp(user.email, code, "email_change");
      emailVerificationSent = true;
    }

    if (phone && phone !== user.phone) {
      const phoneExists = await User.findOne({ phone });
      if (phoneExists) {
        return res.status(409).json({ message: "Bu telefon nömrəsi artıq istifadə olunur." });
      }
      user.phone = phone;
    }

    if (fullName !== undefined) user.fullName = fullName;
    if (bio !== undefined) user.bio = bio;

    // Profil şəkli yenilənməsi
    if (req.file) {
      await handleProfileImageUpload(user, req.file);
    } else if (req.body.profileImage !== undefined) {
      user.profileImage = req.body.profileImage;
    }

    await user.save();

    const updatedUser = user.toObject();
    delete updatedUser.password;
    delete updatedUser.__v;

    return res.json({
      success: true,
      message: emailVerificationSent 
        ? "Profiliniz yeniləndi. Email dəyişikliyi üçün köhnə emailinizə təsdiq kodu göndərildi." 
        : "İstifadəçi profiliniz uğurla yeniləndi.",
      user: updatedUser,
      requiresEmailVerification: emailVerificationSent,
    });
  } catch (err) {
    console.error("updateUserProfile error:", err);
    return res.status(500).json({ message: "Server xətası baş verdi." });
  }
};

// PUT /api/users/provider
// Xidmət Təminatçısı (Provider) məlumatlarını yeniləyir
export const updateProvider = async (req, res) => {
  try {
    const userId = req.user._id;
    const { fullName, email, bio, location, phone } = req.body;

    const user = await User.findById(userId);
    let emailVerificationSent = false;
    if (!user) {
      return res.status(404).json({ message: "Provider tapılmadı." });
    }

    if (user.role !== "provider") {
      return res.status(403).json({ message: "Bu API yalnız providerlər üçündür." });
    }

    // E-poçt yeniləməsi
    if (email && email !== user.email) {
      const emailExists = await User.findOne({ email });
      if (emailExists) {
        return res.status(409).json({ message: "Bu E-poçt ünvanı artıq istifadə olunur." });
      }

      const code = String(Math.floor(100000 + Math.random() * 900000));
      const otpHash = crypto.createHash("sha256").update(code).digest("hex");
      
      await Otp.findOneAndUpdate(
        { email: user.email, purpose: "email_change" },
        {
          otpHash,
          newEmail: email,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
          attemptsLeft: 5,
          lastSentAt: new Date(),
        },
        { upsert: true }
      );
      
      await sendEmailOtp(user.email, code, "email_change");
      emailVerificationSent = true;
    }

    // Telefon yeniləməsi
    if (phone && phone !== user.phone) {
      const phoneExists = await User.findOne({ phone });
      if (phoneExists) {
        return res.status(409).json({ message: "Bu telefon nömrəsi artıq istifadə olunur." });
      }
      user.phone = phone;
    }

    if (fullName !== undefined) user.fullName = fullName;


    // Providerin Bio və Location hissəsi ("providerProfile.about" bərabərdir Bio-ya)
    if (user.providerProfile) {
      if (bio !== undefined) user.providerProfile.about = bio;
      if (location !== undefined) user.providerProfile.location = location;
    }

    // Profil şəkli yenilənməsi (Əgər fayl göndərilibsə və ya JSON-da URL gəlibsə)
    if (req.file) {
      await handleProfileImageUpload(user, req.file);
    } else if (req.body.profileImage !== undefined) {
      user.profileImage = req.body.profileImage;
    }

    await user.save();

    const updatedUser = user.toObject();
    delete updatedUser.password;
    delete updatedUser.__v;

    return res.json({
      success: true,
      message: emailVerificationSent 
        ? "Profiliniz yeniləndi. Email dəyişikliyi üçün köhnə emailinizə təsdiq kodu göndərildi." 
        : "Provider profiliniz uğurla yeniləndi.",
      user: updatedUser,
      requiresEmailVerification: emailVerificationSent,
    });
  } catch (err) {
    console.error("updateProvider error:", err);
    return res.status(500).json({ message: "Server xətası baş verdi." });
  }
};

// ============================================================
// GET /api/users/provider/:id/contact
// Providerin əlaqə məlumatlarını qaytarır
// requireAuth ilə qorunur — guest → LOGIN_REQUIRED (route səviyyəsində)
// ============================================================
export const getProviderContact = async (req, res) => {
  try {
    const provider = await User.findById(req.params.id)
      .select("fullName email phone role providerProfile")
      .lean();

    if (!provider) {
      return res.status(404).json({ message: "Provider tapılmadı." });
    }

    if (provider.role !== "provider") {
      return res.status(404).json({ message: "Bu istifadəçi provider deyil." });
    }

    return res.json({
      success: true,
      contact: {
        fullName:    provider.fullName,
        email:       provider.email,
        phone:       provider.phone   || null,
        companyName: provider.providerProfile?.companyName || null,
        location:    provider.providerProfile?.location    || null,
        website:     provider.providerProfile?.website     || null,
        instagram:   provider.providerProfile?.instagram   || null,
        whatsapp:    provider.providerProfile?.whatsapp    || null,
      },
    });
  } catch (err) {
    console.error("getProviderContact error:", err);
    return res.status(500).json({ message: "Server xətası baş verdi." });
  }
};
// ============================================================
// GET /api/users/provider/:id/whatsapp
// Provider'ın WhatsApp nömrəsinə birbaşa yönləndirmə (302 Redirect)
// ============================================================
export const redirectToWhatsapp = async (req, res) => {
  try {
    const provider = await User.findById(req.params.id)
      .select("phone role providerProfile")
      .lean();

    if (!provider || provider.role !== "provider") {
      return res.status(404).json({ message: "Provider tapılmadı." });
    }

    // Əgər providerProfile-da xüsusi whatsapp nömrəsi varsa onu, yoxdursa əsas telefonu götür
    const whatsappNumber = provider.providerProfile?.whatsapp || provider.phone;
    
    if (!whatsappNumber) {
      return res.status(400).json({ message: "Bu provider-in WhatsApp məlumatı yoxdur." });
    }

    // Telefon nömrəsini təmizləmək (təkcə rəqəmlər)
    const cleanNumber = whatsappNumber.replace(/\D/g, "");
    const whatsappUrl = `https://wa.me/${cleanNumber}`;

    // Birbaşa yönləndirmə
    return res.redirect(whatsappUrl);
  } catch (err) {
    console.error("redirectToWhatsapp error:", err);
    return res.status(500).json({ message: "Server xətası baş verdi." });
  }
};

// ============================================================
// DELETE /api/users/profile-image
// Profil şəklini sil (User + Provider)
// ============================================================
export const deleteProfileImage = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: "İstifadəçi tapılmadı." });
    }

    if (!user.profileImagePublicId) {
      return res.status(400).json({ message: "Profil şəkli mövcud deyil." });
    }

    // R2-dən sil
    await deleteFromR2(user.profileImagePublicId);

    // DB-dən təmizlə
    user.profileImage = null;
    user.profileImagePublicId = null;
    await user.save();

    return res.json({
      success: true,
      message: "Profil şəkli silindi.",
    });
  } catch (err) {
    console.error("deleteProfileImage error:", err);
    return res.status(500).json({ message: "Server xətası baş verdi." });
  }
};

// ============================================================
// POST /api/users/verify-email-change
// Köhnə emailə göndərilən OTP ilə yeni emailə keçid
// requireAuth ilə qorunur
// ============================================================
export const verifyEmailChange = async (req, res) => {
  try {
    const userId = req.user._id;
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({ message: "OTP kodu daxil edin." });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "İstifadəçi tapılmadı." });
    }

    // Köhnə email üçün email_change OTP-ni tap
    const record = await Otp.findOne({ email: user.email, purpose: "email_change" });
    if (!record) {
      return res.status(400).json({ message: "Email dəyişmə tələbi tapılmadı. Yenidən cəhd edin." });
    }

    // Vaxt yoxlaması
    if (record.expiresAt.getTime() < Date.now()) {
      await Otp.deleteOne({ _id: record._id });
      return res.status(400).json({ message: "OTP-nin vaxtı bitib. Yenidən email dəyişmə tələbi göndərin." });
    }

    // Cəhd sayı yoxlaması
    if (record.attemptsLeft <= 0) {
      await Otp.deleteOne({ _id: record._id });
      return res.status(429).json({ message: "Çox cəhd edildi. Yenidən email dəyişmə tələbi göndərin." });
    }

    // OTP hash yoxlaması
    const inputHash = crypto.createHash("sha256").update(String(code).trim()).digest("hex");
    if (inputHash !== record.otpHash) {
      record.attemptsLeft -= 1;
      await record.save();
      return res.status(400).json({
        message: "OTP yanlışdır.",
        attemptsLeft: record.attemptsLeft,
      });
    }

    // OTP doğrudur — yeni emailə keç
    const newEmail = record.newEmail;

    // Yeni emailin başqa istifadəçidə olmadığını yenidən yoxla
    const emailTaken = await User.findOne({ email: newEmail });
    if (emailTaken) {
      await Otp.deleteOne({ _id: record._id });
      return res.status(409).json({ message: "Bu email artıq başqa bir istifadəçiyə məxsusdur." });
    }

    user.email = newEmail;
    await user.save();
    await Otp.deleteOne({ _id: record._id });

    const updatedUser = user.toObject();
    delete updatedUser.password;
    delete updatedUser.__v;

    return res.json({
      success: true,
      message: "Email ünvanınız uğurla yeniləndi.",
      user: updatedUser,
    });
  } catch (err) {
    console.error("verifyEmailChange error:", err);
    return res.status(500).json({ message: "Server xətası baş verdi." });
  }
};
