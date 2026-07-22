import { z } from "zod";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import Otp from "../models/Otp.js";
import Category from "../models/Category.js";
import { sendEmailOtp } from "../utils/email.js";
import { signAccessToken } from "../utils/jwt.js";
import mongoose from "mongoose";

const normalizeEmail = (e) =>
  String(e || "")
    .trim()
    .toLowerCase();
const normalizePhone = (p) => String(p || "").trim();

const gen6 = () => String(Math.floor(100000 + Math.random() * 900000));
const sha256 = (s) =>
  crypto.createHash("sha256").update(String(s)).digest("hex");

async function createOrUpdateOtp({ email, purpose }) {
  const code = gen6();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await Otp.findOneAndUpdate(
    { email, purpose },
    {
      otpHash: sha256(code),
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
  password: z.string().min(6),
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
    });

    // ✅ register-dən sonra OTP göndər
    await createOrUpdateOtp({ email, purpose: "register" });

    return res.status(201).json({
      message: "Qeydiyyat tamamlandı, OTP email-ə göndərildi",
      email,
      next: "register_verify_otp",
    });
  } catch (e) {
    console.error(e);
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
    password:        z.string().min(6),
    confirmPassword: z.string().min(6),
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
    });

    await createOrUpdateOtp({ email, purpose: "register" });

    return res.status(201).json({
      message: "Qeydiyyat tamamlandı, OTP email-ə göndərildi",
      email,
      next: "register_verify_otp",
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server xətası" });
  }
}

/* ---------------- REGISTER VERIFY OTP -> TOKEN ---------------- */

const verifyRegisterOtpSchema = z.object({
  email: z.string().trim().email(),
  code: z.string().trim().length(6),
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

    const record = await Otp.findOne({ email, purpose });
    if (!record) return res.status(400).json({ error: "OTP tapılmadı" });

    if (record.expiresAt.getTime() < Date.now()) {
      await Otp.deleteOne({ _id: record._id });
      return res.status(400).json({ error: "OTP vaxtı bitib" });
    }

    if (record.attemptsLeft <= 0) {
      await Otp.deleteOne({ _id: record._id });
      return res.status(429).json({ error: "Çox cəhd edildi" });
    }

    const ok = sha256(code) === record.otpHash;
    if (!ok) {
      record.attemptsLeft -= 1;
      await record.save();
      return res.status(400).json({ error: "OTP yanlışdır" });
    }

    await Otp.deleteOne({ _id: record._id });

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: "User tapılmadı" });

    // ✅ email verified
    if (!user.emailVerified) {
      user.emailVerified = true;
      await user.save();
    }

    const token = signAccessToken({ id: user._id.toString(), role: user.role });

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
    console.error(e);
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
    console.error(e);
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

    // Admin tərəfindən bloklanıbsa girişə icazə verilmir
    if (user.isBlocked) {
      return res.status(403).json({
        error: "ACCOUNT_BLOCKED",
        message: "Hesabınız admin tərəfindən bloklanmışdır. Ətraflı məlumat üçün bizimlə əlaqə saxlayın.",
      });
    }

    const token = signAccessToken({ id: user._id.toString(), role: user.role });

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
    console.error(e);
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
    console.error(e);
    return res.status(500).json({ error: "Server xətası" });
  }
}

/* ------------- FORGOT PASSWORD — VERIFY OTP → RESET TOKEN ------------- */

const verifyForgotOtpSchema = z.object({
  email: z.string().trim().email(),
  code: z.string().trim().length(6),
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

    const record = await Otp.findOne({ email, purpose });
    if (!record) return res.status(400).json({ error: "OTP tapılmadı" });

    if (record.expiresAt.getTime() < Date.now()) {
      await Otp.deleteOne({ _id: record._id });
      return res.status(400).json({ error: "OTP vaxtı bitib" });
    }

    if (record.attemptsLeft <= 0) {
      await Otp.deleteOne({ _id: record._id });
      return res.status(429).json({ error: "Çox cəhd edildi" });
    }

    const ok = sha256(code) === record.otpHash;
    if (!ok) {
      record.attemptsLeft -= 1;
      await record.save();
      return res.status(400).json({ error: "OTP yanlışdır" });
    }

    await Otp.deleteOne({ _id: record._id });

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: "User tapılmadı" });

    // Qısa ömürlü reset token (15 dəqiqə)
    const resetToken = jwt.sign(
      { id: user._id.toString(), purpose: "reset_password" },
      process.env.JWT_SECRET,
      { expiresIn: "15m" },
    );

    return res.json({
      message: "OTP təsdiqləndi, şifrəni sıfırlaya bilərsiniz",
      resetToken,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server xətası" });
  }
}

/* ------------- FORGOT PASSWORD — RESET PASSWORD ------------- */

const resetPasswordSchema = z.object({
  resetToken: z.string().min(1),
  newPassword: z.string().min(6),
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
      payload = jwt.verify(parsed.data.resetToken, process.env.JWT_SECRET);
    } catch {
      return res.status(400).json({ error: "Reset token etibarsızdır və ya vaxtı bitib" });
    }

    if (payload.purpose !== "reset_password")
      return res.status(400).json({ error: "Yanlış token növü" });

    const user = await User.findById(payload.id);
    if (!user) return res.status(404).json({ error: "User tapılmadı" });

    user.password = await bcrypt.hash(parsed.data.newPassword, 10);
    await user.save();

    return res.json({ message: "Şifrə uğurla yeniləndi" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server xətası" });
  }
}
