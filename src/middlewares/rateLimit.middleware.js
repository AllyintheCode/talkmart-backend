import rateLimit from "express-rate-limit";

// Engagement əməliyyatları üçün rate limiter
// Hər user (IP əsaslı) 1 dəqiqədə max 30 request edə bilər
export const engagementLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 dəqiqə
  max: 30, // hər pəncərədə max 30 request
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Çox tez-tez əməliyyat edirsiniz. 1 dəqiqə gözləyin.",
  },
  // User ID varsa, ona əsasən limit et (daha dəqiq)
  keyGenerator: (req) => {
    return req.user?._id?.toString() || (req.ip || "unknown").replace(/:/g, "_");
  },
});

// Qeydiyyat, Login və Şifrə Yeniləmə (Auth & OTP) üçün limiter
// Hər IP (və ya mail) 10 dəqiqədə maksimum 5 giriş/cəhd edə bilər
export const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 dəqiqə
  max: 5, // 5 cəhd
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: "RATE_LIMIT_EXCEEDED",
    message: "Həddindən artıq cəhd etdiniz. Lütfən 10 dəqiqə sonra yenidən cəhd edin.",
  },
  keyGenerator: (req) => {
    // E-mail əsaslı və ya İP əsaslı qorunma
    return req.body?.email || req.ip || "unknown";
  },
});
