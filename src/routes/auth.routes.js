import { Router } from "express";
import { sendOtp, verifyOtp } from "../controllers/auth.controller.js";

const router = Router();

router.post("/send-otp", sendOtp);
router.post("/verify-otp", verifyOtp);

export default router;
