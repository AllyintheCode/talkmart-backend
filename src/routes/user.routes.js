import { Router } from "express";
import { updateUser, updateProvider } from "../controllers/user.controller.js";
import { verifyToken, providerOnly } from "../middlewares/auth.middleware.js";

const router = Router();

// PUT /api/users/user -> Yalnız adi istifadəçiləri (User) yeniləyir
router.put("/user", verifyToken, updateUser);

// PUT /api/users/provider -> Yalnız xidmət təminatçısını (Provider) yeniləyir
router.put("/provider", verifyToken, providerOnly, updateProvider);

export default router;
