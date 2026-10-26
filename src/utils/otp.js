import crypto from "crypto";
import Otp from "../models/Otp.js";


/**
 * Kriptoqrafik təhlükəsiz 6 rəqəmli OTP generasiyası (TM-003)
 */
export function generateOtpCode() {
  return String(crypto.randomInt(100000, 1000000));
}

/**
 * Məqsəd və email üzrə HMAC-SHA256 heş hesablama
 */
export function hashOtp(purpose, email, code) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const normalizedPurpose = String(purpose || "").trim();
  const normalizedCode = String(code || "").trim();
  const pepper = process.env.OTP_PEPPER;
  if (!pepper || pepper.length < 32) throw new Error("OTP_PEPPER_REQUIRED");

  return crypto
    .createHmac("sha256", pepper)
    .update(`${normalizedPurpose}:${normalizedEmail}:${normalizedCode}`)
    .digest("hex");
}

/**
 * Timing-safe constant time OTP yoxlanışı (TM-003)
 */
export function verifyOtpHash(purpose, email, submittedCode, savedHash) {
  if (!savedHash || !submittedCode) return false;

  const expectedHash = hashOtp(purpose, email, submittedCode);

  try {
    const savedBuf = Buffer.from(savedHash, "hex");
    const expectedBuf = Buffer.from(expectedHash, "hex");

    if (savedBuf.length === expectedBuf.length && crypto.timingSafeEqual(savedBuf, expectedBuf)) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * OTP-ni atomik şəkildə yoxlayır və uğurlu olduqda istehlak edir (TM-003)
 * @returns {{ ok: true } | { ok: false, status: number, error: string }}
 */
export async function consumeOtp({ email, purpose, code }) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const normalizedCode = String(code || "").trim();

  const record = await Otp.findOne({ email: normalizedEmail, purpose });
  if (!record) {
    return { ok: false, status: 401, error: "OTP tapılmadı" };
  }

  if (record.expiresAt.getTime() < Date.now()) {
    await Otp.deleteOne({ _id: record._id, otpHash: record.otpHash, expiresAt: { $lte: new Date() } });
    return { ok: false, status: 401, error: "OTP vaxtı bitib" };
  }

  if (record.attemptsLeft <= 0) {
    return { ok: false, status: 429, error: "Çox cəhd edildi" };
  }

  const matched = verifyOtpHash(purpose, normalizedEmail, normalizedCode, record.otpHash);
  if (!matched) {
    const updated = await Otp.findOneAndUpdate(
      { _id: record._id, otpHash: record.otpHash, expiresAt: { $gt: new Date() }, attemptsLeft: { $gt: 0 } },
      { $inc: { attemptsLeft: -1 } },
      { returnDocument: "after" },
    );
    if (!updated || updated.attemptsLeft <= 0) {
      return { ok: false, status: 429, error: "Çox cəhd edildi" };
    }
    return { ok: false, status: 400, error: "OTP yanlışdır", attemptsLeft: updated.attemptsLeft };
  }

  const consumed = await Otp.findOneAndDelete({
    _id: record._id,
    otpHash: record.otpHash,
    attemptsLeft: { $gt: 0 },
    expiresAt: { $gt: new Date() },
  });
  if (!consumed) {
    return { ok: false, status: 401, error: "OTP artıq istifadə edilib və ya vaxtı bitib" };
  }

  return { ok: true, record: consumed };
}
