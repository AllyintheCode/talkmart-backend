import { Router } from "express";
import {
  registerUser,
  registerProvider,
  verifyRegisterOtp,
  resendRegisterOtp,
  login,
  forgotPassword,
  verifyForgotOtp,
  resetPassword,
} from "../controllers/auth.controller.js";
import { authLimiter } from "../middlewares/rateLimit.middleware.js";

const router = Router();

// register + auto otp (Rate Limit ilə qorunur)
router.post("/register/user", authLimiter, registerUser);
router.post("/register/provider", authLimiter, registerProvider);
router.post("/register/verify-otp", authLimiter, verifyRegisterOtp);
router.post("/register/resend-otp", authLimiter, resendRegisterOtp);
  
// login (email + password)
router.post("/login", authLimiter, login);

// forgot password
router.post("/forgot-password", authLimiter, forgotPassword);
router.post("/forgot-password/verify-otp", authLimiter, verifyForgotOtp);
router.post("/forgot-password/reset-password", authLimiter, resetPassword);

export default router;
