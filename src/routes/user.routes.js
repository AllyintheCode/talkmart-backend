import { Router } from "express";
import { getUserProfile, getProviderProfile, changePassword, updateUser, updateProvider, getProviderContact, deleteProfileImage, updateUserProfile, verifyEmailChange, deleteAccount } from "../controllers/user.controller.js";
import { requireAuth, providerOnly } from "../middlewares/auth.middleware.js";
import { uploadImage } from "../middlewares/upload.middleware.js";

import { authLimiter, engagementLimiter } from "../middlewares/rateLimit.middleware.js";
import { validateId } from "../middlewares/api.middleware.js";
const router = Router();
router.param("id", validateId);

// ============================================================
// GET /api/users/user → Adi istifadəçi profilini gətir
// requireAuth: guest → LOGIN_REQUIRED
// ============================================================
router.get("/user", requireAuth, getUserProfile);

// ============================================================
// PUT /api/users/change-password → Şifrəni yenilə
// requireAuth: guest → LOGIN_REQUIRED
// ============================================================
router.put("/change-password", requireAuth, changePassword);

// ============================================================
// PUT /api/users/user → Adi istifadəçi profilini yenilə
// requireAuth: guest → LOGIN_REQUIRED
// ============================================================
router.put("/user", requireAuth, authLimiter, uploadImage.single("profileImage"), updateUser);

// ============================================================
// GET /api/users/profile → Adi istifadəçi profilini gətir (alias of /user)
// requireAuth: guest → LOGIN_REQUIRED
// ============================================================
router.get("/profile", requireAuth, getUserProfile);

// ============================================================
// POST /api/users/profile → Adi istifadəçi profilini yenilə (bio, şəkil, vs)
// requireAuth: guest → LOGIN_REQUIRED
// ============================================================
router.post("/profile", requireAuth, authLimiter, uploadImage.single("profileImage"), updateUserProfile);

// ============================================================
// GET /api/users/provider → Provider profilini gətir
// requireAuth: guest → LOGIN_REQUIRED
// ============================================================
router.get("/provider", requireAuth, providerOnly, getProviderProfile);

// ============================================================
// PUT /api/users/provider → Provider profilini yenilə
// requireAuth: guest → LOGIN_REQUIRED
// ============================================================
router.put("/provider", requireAuth, providerOnly, authLimiter, uploadImage.single("profileImage"), updateProvider);

// ============================================================
// DELETE /api/users/profile-image → Profil şəklini sil (User + Provider)
// requireAuth: guest → LOGIN_REQUIRED
// ============================================================
router.delete("/profile-image", requireAuth, deleteProfileImage);

// ============================================================
// POST /api/users/verify-email-change → Email dəyişmə təsdiq OTP
// requireAuth: guest → LOGIN_REQUIRED
// ============================================================
router.post("/verify-email-change", requireAuth, authLimiter, verifyEmailChange);

// ============================================================
// GET /api/users/provider/:id/contact → Providerin əlaqə məlumatı
// LOGIN TƏLƏB OLUNUR — guest istifadəçilər login ekranına yönləndirilir
// ============================================================
router.get("/provider/:id/contact", requireAuth, getProviderContact);

// ============================================================
// GET /api/users/provider/:id/whatsapp → Birbaşa WhatsApp-a yönləndir
// Əlaqə məlumatlarına çıxış giriş tələb edir
import { redirectToWhatsapp } from "../controllers/user.controller.js";
router.get("/provider/:id/whatsapp", requireAuth, redirectToWhatsapp);

// ============================================================
// DELETE /api/users/account → İstifadəçinin öz hesabını silməsi
// requireAuth: guest → LOGIN_REQUIRED
// ============================================================
router.delete("/account", requireAuth, deleteAccount);

// ============================================================
// POST /api/users/block/:id → Digər istifadəçini bloklamaq
// requireAuth: guest → LOGIN_REQUIRED
// ============================================================
import { blockUser, unblockUser } from "../controllers/user.controller.js";
router.post("/block/:id", requireAuth, blockUser);

// ============================================================
// POST /api/users/unblock/:id → Blokdan çıxarmaq
// requireAuth: guest → LOGIN_REQUIRED
// ============================================================
router.post("/unblock/:id", requireAuth, unblockUser);

// ============================================================
// GET /api/users/blocked → İstifadəçinin (və ya providerin) blokladığı şəxsləri gətir
// ============================================================
import { getBlockedUsers } from "../controllers/user.controller.js";
router.get("/blocked", requireAuth, getBlockedUsers);

// ============================================================
// POST /api/users/report → Şikayət etmək (istifadəçi və ya video)
// requireAuth: guest → LOGIN_REQUIRED
// ============================================================
import { reportContent } from "../controllers/user.controller.js";
router.post("/report", requireAuth, engagementLimiter, reportContent);

export default router;

