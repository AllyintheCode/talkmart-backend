import { z } from "zod";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import Otp from "../models/Otp.js";
import { sendEmailOtp } from "../utils/email.js";
import { signAccessToken } from "../utils/jwt.js";

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
  fullName: z.string().min(2),
  phone: z.string().min(7),
  email: z.string().email(),
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

    const exists = await User.findOne({ $or: [{ email }, { phone }] });
    if (exists)
      return res
        .status(409)
        .json({ error: "Bu email və ya phone artıq qeydiyyatdadır" });

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

const providerRegisterSchema = z.object({
  fullName: z.string().min(2),
  companyName: z.string().min(2),
  phone: z.string().min(7),
  email: z.string().email(),
  password: z.string().min(6),
  primaryServices: z.array(z.string().min(1)).min(1),
  location: z.string().min(2),
  about: z.string().min(10),
});

export async function registerProvider(req, res) {
  try {
    const parsed = providerRegisterSchema.safeParse(req.body);
    if (!parsed.success)
      return res
        .status(400)
        .json({ error: "Validation error", details: parsed.error.issues });

    const email = normalizeEmail(parsed.data.email);
    const phone = normalizePhone(parsed.data.phone);
    const hashedPassword = await bcrypt.hash(parsed.data.password, 10);

    const exists = await User.findOne({ $or: [{ email }, { phone }] });
    if (exists)
      return res
        .status(409)
        .json({ error: "Bu email və ya phone artıq qeydiyyatdadır" });

    await User.create({
      role: "provider",
      fullName: parsed.data.fullName.trim(),
      email,
      phone,
      password: hashedPassword,
      providerProfile: {
        companyName: parsed.data.companyName.trim(),
        primaryServices: parsed.data.primaryServices.map((s) => s.trim()),
        location: parsed.data.location.trim(),
        about: parsed.data.about.trim(),
        verified: false,
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
  email: z.string().email(),
  code: z.string().length(6),
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

/* ---------------- LOGIN (EMAIL + PASSWORD) ---------------- */

const loginSchema = z.object({
  email: z.string().email(),
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
  email: z.string().email(),
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
  email: z.string().email(),
  code: z.string().length(6),
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
