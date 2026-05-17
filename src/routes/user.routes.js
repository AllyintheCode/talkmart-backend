import { Router } from "express";
import { updateUser, updateProvider, getProviderContact, deleteProfileImage } from "../controllers/user.controller.js";
import { requireAuth, providerOnly, optionalAuth } from "../middlewares/auth.middleware.js";
import { uploadImage } from "../middlewares/upload.middleware.js";

const router = Router();

// ============================================================
// PUT /api/users/user → Adi istifadəçi profilini yenilə
// requireAuth: guest → LOGIN_REQUIRED
// ============================================================
router.put("/user", requireAuth, updateUser);

// ============================================================
// PUT /api/users/provider → Provider profilini yenilə
// requireAuth: guest → LOGIN_REQUIRED
// ============================================================
router.put("/provider", requireAuth, providerOnly, uploadImage.single("profileImage"), updateProvider);

// ============================================================
// DELETE /api/users/profile-image → Profil şəklini sil (User + Provider)
// requireAuth: guest → LOGIN_REQUIRED
// ============================================================
router.delete("/profile-image", requireAuth, deleteProfileImage);

// ============================================================
// GET /api/users/provider/:id/contact → Providerin əlaqə məlumatı
// LOGIN TƏLƏB OLUNUR — guest istifadəçilər login ekranına yönləndirilir
// ============================================================
router.get("/provider/:id/contact", requireAuth, getProviderContact);

// ============================================================
// GET /api/users/provider/:id/whatsapp → Birbaşa WhatsApp-a yönləndir
// 🔓 GUEST DOSTU — Həm qonaqlar, həm də login olanlar üçün WhatsApp açır
import { redirectToWhatsapp } from "../controllers/user.controller.js";
router.get("/provider/:id/whatsapp", optionalAuth, redirectToWhatsapp);


export default router;
