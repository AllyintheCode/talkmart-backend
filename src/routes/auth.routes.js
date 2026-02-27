import { Router } from "express";
import {
  registerUser,
  registerProvider,
  sendLoginOtp,
  verifyLoginOtp,
} from "../controllers/auth.controller.js";

const router = Router();

router.post("/register/user", registerUser);
router.post("/register/provider", registerProvider);
router.post("/login/send-otp", sendLoginOtp);
router.post("/login/verify-otp", verifyLoginOtp);

export default router;
