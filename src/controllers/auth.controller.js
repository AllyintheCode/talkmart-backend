import { z } from "zod";
import crypto from "crypto";
import User from "../models/User.js";
import Otp from "../models/Otp.js";
import { sendEmailOtp } from "../utils/email.js";
import { signAccessToken } from "../utils/jwt.js";

const normalizeEmail = (e) =>
  String(e || "")
    .trim()
    .toLowerCase();
const normalizePhone = (p) => String(p || "").trim(); // istəsən AZ normalize edərik

const gen6 = () => String(Math.floor(100000 + Math.random() * 900000));
const sha256 = (s) =>
  crypto.createHash("sha256").update(String(s)).digest("hex");

/* ---------------- REGISTER ---------------- */

const userRegisterSchema = z.object({
  fullName: z.string().min(2),
  phone: z.string().min(7),
  email: z.string().email(),
});

export async function registerUser(req, res) {
  const parsed = userRegisterSchema.safeParse(req.body);
  if (!parsed.success)
    return res
      .status(400)
      .json({ error: "Validation error", details: parsed.error.issues });

  const fullName = parsed.data.fullName.trim();
  const email = normalizeEmail(parsed.data.email);
  const phone = normalizePhone(parsed.data.phone);

  // email və phone unikaldır
  const exists = await User.findOne({ $or: [{ email }, { phone }] });
  if (exists)
    return res
      .status(409)
      .json({ error: "Bu email və ya phone artıq qeydiyyatdadır" });

  const user = await User.create({
    role: "user",
    fullName,
    email,
    phone,
    providerProfile: null,
  });

  return res.status(201).json({
    message: "User qeydiyyatı tamamlandı",
    user: {
      id: user._id,
      role: user.role,
      fullName: user.fullName,
      email: user.email,
      phone: user.phone,
    },
  });
}

const providerRegisterSchema = z.object({
  fullName: z.string().min(2),
  companyName: z.string().min(2),
  phone: z.string().min(7),
  email: z.string().email(),
  primaryServices: z.array(z.string().min(1)).min(1),
  location: z.string().min(2),
  about: z.string().min(10),
});

export async function registerProvider(req, res) {
  const parsed = providerRegisterSchema.safeParse(req.body);
  if (!parsed.success)
    return res
      .status(400)
      .json({ error: "Validation error", details: parsed.error.issues });

  const email = normalizeEmail(parsed.data.email);
  const phone = normalizePhone(parsed.data.phone);

  const exists = await User.findOne({ $or: [{ email }, { phone }] });
  if (exists)
    return res
      .status(409)
      .json({ error: "Bu email və ya phone artıq qeydiyyatdadır" });

  const user = await User.create({
    role: "provider",
    fullName: parsed.data.fullName.trim(),
    email,
    phone,
    providerProfile: {
      companyName: parsed.data.companyName.trim(),
      primaryServices: parsed.data.primaryServices.map((s) => s.trim()),
      location: parsed.data.location.trim(),
      about: parsed.data.about.trim(),
      verified: false,
    },
  });

  return res.status(201).json({
    message: "Provider qeydiyyatı tamamlandı",
    user: {
      id: user._id,
      role: user.role,
      fullName: user.fullName,
      email: user.email,
      phone: user.phone,
      providerProfile: user.providerProfile,
    },
  });
}

/* ---------------- LOGIN OTP ---------------- */

const sendLoginOtpSchema = z.object({
  email: z.string().email(),
});

export async function sendLoginOtp(req, res) {
  const parsed = sendLoginOtpSchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: "Validation error" });

  const email = normalizeEmail(parsed.data.email);

  // Login üçün mütləq user DB-də olmalıdır (register-dən sonra)
  const user = await User.findOne({ email });
  if (!user)
    return res
      .status(404)
      .json({ error: "Bu email ilə hesab tapılmadı (əvvəl register et)" });

  const purpose = "login";

  // 60s cooldown
  const existing = await Otp.findOne({ email, purpose });
  if (existing?.lastSentAt) {
    const diffSec =
      (Date.now() - new Date(existing.lastSentAt).getTime()) / 1000;
    if (diffSec < 60)
      return res
        .status(429)
        .json({ error: "OTP çox tez istənildi. 60 saniyə gözlə." });
  }

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
    { upsert: true, new: true },
  );

  await sendEmailOtp(email, code);

  return res.json({ message: "OTP email-ə göndərildi" });
}

const verifyLoginOtpSchema = z.object({
  email: z.string().email(),
  code: z.string().length(6),
});

export async function verifyLoginOtp(req, res) {
  const parsed = verifyLoginOtpSchema.safeParse(req.body);
  if (!parsed.success)
    return res
      .status(400)
      .json({ error: "Validation error", details: parsed.error.issues });

  const email = normalizeEmail(parsed.data.email);
  const code = String(parsed.data.code).trim();
  const purpose = "login";

  const record = await Otp.findOne({ email, purpose });
  if (!record)
    return res.status(400).json({ error: "OTP tapılmadı (yenidən send et)" });

  if (record.expiresAt.getTime() < Date.now()) {
    await Otp.deleteOne({ _id: record._id });
    return res.status(400).json({ error: "OTP vaxtı bitib" });
  }

  if (record.attemptsLeft <= 0) {
    await Otp.deleteOne({ _id: record._id });
    return res.status(429).json({ error: "Çox cəhd edildi. Yenidən OTP al." });
  }

  const ok = sha256(code) === record.otpHash;
  if (!ok) {
    record.attemptsLeft -= 1;
    await record.save();
    return res.status(400).json({ error: "OTP yanlışdır" });
  }

  await Otp.deleteOne({ _id: record._id });

  const user = await User.findOne({ email });
  if (!user)
    return res
      .status(404)
      .json({ error: "Hesab tapılmadı (register lazımdır)" });

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
      providerProfile:
        user.role === "provider" ? user.providerProfile : undefined,
    },
  });
}
