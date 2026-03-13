import { Router } from "express";
import {
  registerUser,
  registerProvider,
  verifyRegisterOtp,
  login,
  forgotPassword,
  verifyForgotOtp,
  resetPassword,
} from "../controllers/auth.controller.js";

const router = Router();

// register + auto otp
router.post("/register/user", registerUser);
router.post("/register/provider", registerProvider);
router.post("/register/verify-otp", verifyRegisterOtp);

// login (email + password)
router.post("/login", login);

// forgot password
router.post("/forgot-password", forgotPassword);
router.post("/forgot-password/verify-otp", verifyForgotOtp);
router.post("/forgot-password/reset-password", resetPassword);

export default router;
