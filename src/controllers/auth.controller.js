import { logger } from "../utils/logger.js";
import { z } from "zod";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import User from "../models/User.js";
import Otp from "../models/Otp.js";
import Category from "../models/Category.js";
import { sendEmailOtp } from "../utils/email.js";
import {
  signAccessToken,
  signPasswordResetToken,
  verifyPasswordResetToken,
} from "../utils/jwt.js";
import { generateOtpCode, hashOtp, consumeOtp } from "../utils/otp.js";
import { delCache } from "../config/redis.js";
import mongoose from "mongoose";
import AuditEvent from "../models/AuditEvent.js";

const normalizeEmail = (e) =>
  String(e || "")
    .trim()
    .toLowerCase();
const normalizePhone = (p) => String(p || "").trim();

async function createOrUpdateOtp({ email, purpose }) {
  const code = generateOtpCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  const otpHash = hashOtp(purpose, email, code);

  await Otp.findOneAndUpdate(
    { email, purpose },
    {
      otpHash,
      expiresAt,
      attemptsLeft: 5,
      lastSentAt: new Date(),
    },
    { upsert: true, returnDocument: "after" },
  );

  await sendEmailOtp(email, code, purpose);
}

/* ---------------- REGISTER (USER) + OTP ---------------- */

const userRegisterSchema = z.object({
  fullName: z.string().trim().min(2),
  phone: z.string().trim().min(7),
  email: z.string().trim().email(),
  password: z.string().min(6).max(72),
});

export async function registerUser(req, res) {
  try {
    const parsed = userRegisterSchema.safeParse(req.body);
    if (!parsed.success)
      return res
        .status(400)
        .json({ error: "Validation error", details: parsed.error.issues });

    const fullName = parsed.data.fullName.trim();
    const email = normalizeEmail(parsed.data.email);
    const phone = normalizePhone(parsed.data.phone);
    const hashedPassword = await bcrypt.hash(parsed.data.password, 10);

    const existsList = await User.find({ $or: [{ email }, { phone }] });
    for (const user of existsList) {
      if (user.emailVerified) {
        return res.status(409).json({ error: "Bu email və ya telefon nömrəsi artıq qeydiyyatdadır" });
      }
    }
    
    // Əgər təsdiqlənməyibsə, əvvəlki natamam qeydiyyatı və OTP-ləri silirik
    for (const user of existsList) {
      await Otp.deleteMany({ email: user.email, purpose: "register" });
    }
    await User.deleteMany({ $or: [{ email }, { phone }], emailVerified: false });

    await User.create({
      role: "user",
      fullName,
      email,
      phone,
      password: hashedPassword,
      providerProfile: null,
      emailVerified: false,
      sessionVersion: 1,
    });

    // register-dən sonra OTP göndər
    await createOrUpdateOtp({ email, purpose: "register" });

    return res.status(201).json({
      message: "Qeydiyyat tamamlandı, OTP email-ə göndərildi",
      email,
      next: "register_verify_otp",
    });
  } catch (e) {
    logger.error(e);
    return res.status(500).json({ error: "Server xətası" });
  }
}

/* ---------------- REGISTER (PROVIDER) + OTP ---------------- */

const providerRegisterSchema = z
  .object({
    firstName:       z.string().trim().min(2),
    lastName:        z.string().trim().min(2),
    companyName:     z.string().trim().min(2),
    email:           z.string().trim().email(),
    phone:           z.string().trim().min(7),
    categoryId:      z.string().trim().min(1),
    address:         z.string().trim().min(2),
    password:        z.string().min(6).max(72),
    confirmPassword: z.string().min(6).max(72),
  })
  .refine((d) => d.password === d.confirmPassword, {
    message: "Şifrələr uyğun gəlmir",
    path: ["confirmPassword"],
  });

export async function registerProvider(req, res) {
  try {
    const parsed = providerRegisterSchema.safeParse(req.body);
    if (!parsed.success)
      return res
        .status(400)
        .json({ error: "Validation error", details: parsed.error.issues });

    const { firstName, lastName, companyName, categoryId, address, password } = parsed.data;
    const email = normalizeEmail(parsed.data.email);
    const phone = normalizePhone(parsed.data.phone);
    const fullName = `${firstName.trim()} ${lastName.trim()}`;
    const hashedPassword = await bcrypt.hash(password, 10);

    const existsList = await User.find({ $or: [{ email }, { phone }] });
    for (const user of existsList) {
      if (user.emailVerified) {
        return res.status(409).json({ error: "Bu email və ya telefon nömrəsi artıq qeydiyyatdadır" });
      }
    }
    
    // Əgər təsdiqlənməyibsə, əvvəlki natamam qeydiyyatı və OTP-ləri silirik
    for (const user of existsList) {
      await Otp.deleteMany({ email: user.email, purpose: "register" });
    }
    await User.deleteMany({ $or: [{ email }, { phone }], emailVerified: false });

    if (!mongoose.Types.ObjectId.isValid(categoryId))
      return res
        .status(400)
        .json({ error: "Geçərsiz kateqoriya ID formatı" });

    // categoryId-nin həqiqətən mövcud və aktiv olduğunu yoxla
    const category = await Category.findOne({ _id: categoryId, status: "active" });
    if (!category)
      return res
        .status(400)
        .json({ error: "Seçilmiş kateqoriya mövcud deyil və ya aktiv deyil" });

    await User.create({
      role: "provider",
      fullName,
      email,
      phone,
      password: hashedPassword,
      providerProfile: {
        companyName: companyName.trim(),
        categoryId:  categoryId.trim(),
        address:     address.trim(),
        verified:    false,
      },
      emailVerified: false,
      sessionVersion: 1,
    });

    await createOrUpdateOtp({ email, purpose: "register" });

    return res.status(201).json({
      message: "Qeydiyyat tamamlandı, OTP email-ə göndərildi",
      email,
      next: "register_verify_otp",
    });
  } catch (e) {
    logger.error(e);
    return res.status(500).json({ error: "Server xətası" });
  }
}

/* ---------------- REGISTER VERIFY OTP -> TOKEN ---------------- */

const verifyRegisterOtpSchema = z.object({
  email: z.string().trim().email(),
  code: z.string().trim().regex(/^\d{6}$/),
});

export async function verifyRegisterOtp(req, res) {
  try {
    const parsed = verifyRegisterOtpSchema.safeParse(req.body);
    if (!parsed.success)
      return res
        .status(400)
        .json({ error: "Validation error", details: parsed.error.issues });

    const email = normalizeEmail(parsed.data.email);
    const code = String(parsed.data.code).trim();
    const purpose = "register";

    const otpResult = await consumeOtp({ email, purpose, code });
    if (!otpResult.ok) {
      return res.status(otpResult.status).json({ error: otpResult.error });
    }

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: "User tapılmadı" });

    // email verified
    if (!user.emailVerified) {
      user.emailVerified = true;
      await user.save();
    }

    const token = signAccessToken({
      id: user._id.toString(),
      role: user.role,
      sv: user.sessionVersion || 1,
    });

    return res.json({
      message: "Qeydiyyat təsdiqləndi",
      token,
      user: {
        id: user._id,
        role: user.role,
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        emailVerified: user.emailVerified,
        providerProfile:
          user.role === "provider" ? user.providerProfile : undefined,
      },
    });
  } catch (e) {
    logger.error(e);
    return res.status(500).json({ error: "Server xətası" });
  }
}

/* ---------------- RESEND REGISTER OTP ---------------- */

const resendOtpSchema = z.object({
  email: z.string().trim().email(),
});

export async function resendRegisterOtp(req, res) {
  try {
    const parsed = resendOtpSchema.safeParse(req.body);
    if (!parsed.success)
      return res
        .status(400)
        .json({ error: "Validation error", details: parsed.error.issues });

    const email = normalizeEmail(parsed.data.email);
    const user = await User.findOne({ email });

    if (!user) return res.status(404).json({ error: "User tapılmadı" });
    if (user.emailVerified)
      return res.status(400).json({ error: "Email artıq təsdiqlənib" });

    const lastOtp = await Otp.findOne({ email, purpose: "register" });
    if (lastOtp && Date.now() - lastOtp.lastSentAt.getTime() < 60000) {
      return res.status(429).json({ error: "Lütfən 1 dəqiqə gözləyin" });
    }

    await createOrUpdateOtp({ email, purpose: "register" });

    return res.json({ message: "Yeni OTP göndərildi", email });
  } catch (e) {
    logger.error(e);
    return res.status(500).json({ error: "Server xətası" });
  }
}

/* ---------------- LOGIN (EMAIL + PASSWORD) ---------------- */

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

export async function login(req, res) {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: "Validation error" });

    const email = normalizeEmail(parsed.data.email);

    const user = await User.findOne({ email });
    if (!user)
      return res
        .status(401)
        .json({ error: "Email və ya şifrə yanlışdır" });

    const passwordMatch = await bcrypt.compare(parsed.data.password, user.password);
    if (!passwordMatch)
      return res
        .status(401)
        .json({ error: "Email və ya şifrə yanlışdır" });

    // Email təsdiqlənməyibsə girişə icazə verilmir
    if (!user.emailVerified) {
      return res.status(403).json({
        error: "EMAIL_NOT_VERIFIED",
        message: "Zəhmət olmasa əvvəlcə emailə göndərilən OTP-ni təsdiqləyin.",
        email: user.email,
        next: "register_verify_otp",
      });
    }

    // Admin tərəfindən bloklanıbsa girişə icazə verilmir (TM-005)
    if (user.isBlocked || user.accountStatus === "deleting") {
      return res.status(403).json({
        error: "ACCOUNT_BLOCKED",
        message: "Hesabınız admin tərəfindən bloklanmışdır. Ətraflı məlumat üçün bizimlə əlaqə saxlayın.",
      });
    }

    const token = signAccessToken({
      id: user._id.toString(),
      role: user.role,
      sv: user.sessionVersion || 1,
    });

    return res.json({
      message: "Giriş uğurlu",
      token,
      user: {
        id: user._id,
        role: user.role,
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        emailVerified: user.emailVerified,
        providerProfile:
          user.role === "provider" ? user.providerProfile : undefined,
      },
    });
  } catch (e) {
    logger.error(e);
    return res.status(500).json({ error: "Server xətası" });
  }
}

/* ---------------- FORGOT PASSWORD — SEND OTP ---------------- */

const forgotPasswordSchema = z.object({
  email: z.string().trim().email(),
});

export async function forgotPassword(req, res) {
  try {
    const parsed = forgotPasswordSchema.safeParse(req.body);
    if (!parsed.success)
      return res
        .status(400)
        .json({ error: "Validation error", details: parsed.error.issues });

    const email = normalizeEmail(parsed.data.email);

    const user = await User.findOne({ email });
    if (!user) {
      // Təhlükəsizlik: istifadəçi tapılmasa da eyni cavab qaytarırıq
      return res.json({
        message: "Əgər bu email qeydiyyatdadırsa, OTP göndərildi",
      });
    }

    await createOrUpdateOtp({ email, purpose: "forgot_password" });

    return res.json({
      message: "Əgər bu email qeydiyyatdadırsa, OTP göndərildi",
      email,
    });
  } catch (e) {
    logger.error(e);
    return res.status(500).json({ error: "Server xətası" });
  }
}

/* ------------- FORGOT PASSWORD — VERIFY OTP → RESET TOKEN ------------- */

const verifyForgotOtpSchema = z.object({
  email: z.string().trim().email(),
  code: z.string().trim().regex(/^\d{6}$/),
});

export async function verifyForgotOtp(req, res) {
  try {
    const parsed = verifyForgotOtpSchema.safeParse(req.body);
    if (!parsed.success)
      return res
        .status(400)
        .json({ error: "Validation error", details: parsed.error.issues });

    const email = normalizeEmail(parsed.data.email);
    const code = String(parsed.data.code).trim();
    const purpose = "forgot_password";

    const otpResult = await consumeOtp({ email, purpose, code });
    if (!otpResult.ok) {
      return res.status(otpResult.status).json({ error: otpResult.error });
    }

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: "User tapılmadı" });

    // Birdəfəlik jti generatoru (TM-006)
    const jti = crypto.randomUUID();
    const jtiHash = crypto.createHash("sha256").update(jti).digest("hex");
    await User.updateOne({ _id: user._id, accountStatus: { $ne: "deleting" } }, { $set: { resetTokenHash: jtiHash, resetTokenExpiresAt: new Date(Date.now() + 900000) } });

    // Qısa ömürlü, təcrid olunmuş reset token (TM-004)
    const resetToken = signPasswordResetToken({
      id: user._id.toString(),
      jti,
    });

    return res.json({
      message: "OTP təsdiqləndi, şifrəni sıfırlaya bilərsiniz",
      resetToken,
    });
  } catch (e) {
    logger.error(e);
    return res.status(500).json({ error: "Server xətası" });
  }
}

/* ------------- FORGOT PASSWORD — RESET PASSWORD ------------- */

const resetPasswordSchema = z.object({
  resetToken: z.string().min(1),
  newPassword: z.string().min(6).max(72),
});

export async function resetPassword(req, res) {
  try {
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success)
      return res
        .status(400)
        .json({ error: "Validation error", details: parsed.error.issues });

    let payload;
    try {
      payload = verifyPasswordResetToken(parsed.data.resetToken);
    } catch {
      return res.status(400).json({ error: "Reset token etibarsızdır və ya vaxtı bitib" });
    }

    // Atomik birdəfəlik jti istehlakı (TM-006)
    const jtiHash = crypto.createHash("sha256").update(payload.jti || "").digest("hex");
    const password = await bcrypt.hash(parsed.data.newPassword, 10);
    // Nonce consumption, password write and session revocation are one DB operation.
    const user = await User.findOneAndUpdate({
      _id: payload.id, resetTokenHash: jtiHash,
      resetTokenExpiresAt: { $gt: new Date() }, accountStatus: { $ne: "deleting" },
    }, {
      $set: { password, resetTokenHash: null, resetTokenExpiresAt: null },
      $inc: { sessionVersion: 1 },
    }, { returnDocument: "after", runValidators: true });
    if (!user) return res.status(401).json({ error: "RESET_TOKEN_USED", message: "Reset token unavailable" });
    await AuditEvent.create({ targetId: user._id, action: "password_reset" });

    // Redis sessiya keşini təmizlə
    await delCache(`user:session:${user._id}`);

    return res.json({ message: "Şifrə uğurla yeniləndi" });
  } catch (e) {
    logger.error(e);
    return res.status(500).json({ error: "Server xətası" });
  }
}
