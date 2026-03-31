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
