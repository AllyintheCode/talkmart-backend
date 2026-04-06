import rateLimit, { ipKeyGenerator } from "express-rate-limit";

// Engagement əməliyyatları üçün rate limiter
export const engagementLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Çox tez-tez əməliyyat edirsiniz. 1 dəqiqə gözləyin.",
  },
  keyGenerator: (req) => {
    return req.user?._id?.toString() || ipKeyGenerator(req.ip || "unknown");
  },
});

// Auth & OTP üçün limiter
export const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: "RATE_LIMIT_EXCEEDED",
    message:
      "Həddindən artıq cəhd etdiniz. Lütfən 10 dəqiqə sonra yenidən cəhd edin.",
  },
  keyGenerator: (req) => {
    return (
      req.body?.email?.toLowerCase().trim() ||
      ipKeyGenerator(req.ip || "unknown")
    );
  },
});
