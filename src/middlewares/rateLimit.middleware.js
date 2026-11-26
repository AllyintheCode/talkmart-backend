import rateLimit, { ipKeyGenerator, MemoryStore } from "express-rate-limit";
import jwt from "jsonwebtoken";
import Video from "../models/Video.js";
import redis, { isRedisReady } from "../config/redis.js";

const ipKey = (req) => ipKeyGenerator(req.ip || "unknown");

// ============================================================
// HİBRİD STORE
// Redis qoşuludursa sayğaclar Redis-də saxlanılır — PM2 cluster / bir neçə instance
// eyni limiti paylaşır və restart zamanı sayğaclar sıfırlanmır.
// Redis əlçatmazdırsa avtomatik prosesin yaddaşına (MemoryStore) keçir — server dayanmır.
// RATE_LIMIT_STORE=memory ilə Redis tamamilə söndürülə bilər.
// ============================================================
const USE_REDIS_STORE = (process.env.RATE_LIMIT_STORE || "auto").toLowerCase() !== "memory";

class HybridStore {
  constructor(prefix) {
    this.prefix = `rl:${prefix}:`;
    this.memory = new MemoryStore();
    this.localKeys = false;
  }

  init(options) {
    this.windowMs = options.windowMs;
    this.memory.init(options);
  }

  useRedis() {
    return USE_REDIS_STORE && isRedisReady();
  }

  async increment(key) {
    if (this.useRedis()) {
      try {
        const k = this.prefix + key;
        const [[e1, totalHits], [e2, ttl]] = await redis.multi().incr(k).pttl(k).exec();
        if (e1 || e2) throw e1 || e2;
        let resetMs = ttl;
        if (ttl < 0) {
          await redis.pexpire(k, this.windowMs);
          resetMs = this.windowMs;
        }
        return { totalHits, resetTime: new Date(Date.now() + resetMs) };
      } catch (_) {
        // Redis bu an əlçatmazdır — yaddaşa keç
      }
    }
    return this.memory.increment(key);
  }

  async decrement(key) {
    if (this.useRedis()) {
      try { await redis.decr(this.prefix + key); return; } catch (_) {}
    }
    return this.memory.decrement(key);
  }

  async resetKey(key) {
    if (this.useRedis()) {
      try { await redis.del(this.prefix + key); } catch (_) {}
    }
    return this.memory.resetKey(key);
  }
}

// ============================================================
// GLOBAL LIMITER
// Mobil operatorlarda (CGNAT) yüzlərlə istifadəçi eyni IP-ni paylaşır.
// Ona görə: token etibarlıdırsa user ID üzrə, yoxdursa IP üzrə (daha yüksək limitlə) sayılır.
// Burada DB-yə getmirik — yalnız JWT imzası yoxlanır.
// ============================================================
const GLOBAL_USER_LIMIT = parseInt(process.env.GLOBAL_USER_RATE_LIMIT || "300", 10); // dəqiqədə
const GLOBAL_IP_LIMIT = parseInt(process.env.GLOBAL_IP_RATE_LIMIT || "1200", 10); // dəqiqədə

export const identifyForRateLimit = (req, res, next) => {
  req.rateLimitUserId = null;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith("Bearer ")) {
    try {
      const decoded = jwt.verify(auth.split(" ")[1], process.env.JWT_SECRET);
      if (!decoded.purpose && decoded.id) req.rateLimitUserId = String(decoded.id);
    } catch (_) {}
  }
  next();
};

export const globalLimiter = rateLimit({
  store: new HybridStore("global"),
  windowMs: 60 * 1000,
  limit: (req) => (req.rateLimitUserId ? GLOBAL_USER_LIMIT : GLOBAL_IP_LIMIT),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.rateLimitUserId ? `u:${req.rateLimitUserId}` : `ip:${ipKey(req)}`),
  message: {
    success: false,
    error: "RATE_LIMIT_EXCEEDED",
    message: "Çox sorğu göndərdiniz. Bir az gözləyin.",
  },
});

// Engagement əməliyyatları üçün rate limiter
export const engagementLimiter = rateLimit({
  store: new HybridStore("engagement"),
  windowMs: 1 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Çox tez-tez əməliyyat edirsiniz. 1 dəqiqə gözləyin.",
  },
  keyGenerator: (req) => {
    return req.user?._id?.toString() || ipKey(req);
  },
});

// ============================================================
// Auth & OTP limiterləri
// 1) IP + email: konkret hesaba brute-force qarşısını alır. Yalnız email üzrə saymaq
//    başqasının hesabını kilidləməyə (hədəfli DoS) imkan verirdi — indi hücumçu yalnız öz IP-sini kilidləyir.
// 2) Yalnız IP: bir IP-dən çoxlu fərqli email-lə cəhdlərin (email rotation) qarşısını alır.
// ============================================================
const authMessage = {
  success: false,
  error: "RATE_LIMIT_EXCEEDED",
  message: "Həddindən artıq cəhd etdiniz. Lütfən 10 dəqiqə sonra yenidən cəhd edin.",
};

const authEmailLimiter = rateLimit({
  store: new HybridStore("auth-email"),
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: authMessage,
  keyGenerator: (req) => {
    const email = typeof req.body?.email === "string" ? req.body.email.toLowerCase().trim() : "";
    return `${ipKey(req)}|${email}`;
  },
});

const authIpLimiter = rateLimit({
  store: new HybridStore("auth-ip"),
  windowMs: 10 * 60 * 1000,
  max: parseInt(process.env.AUTH_IP_RATE_LIMIT || "50", 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: authMessage,
  keyGenerator: ipKey,
});

export const authLimiter = [authIpLimiter, authEmailLimiter];

// ============================================================
// Video upload limitləri (verifyToken + providerOnly-dən SONRA, multer-dən ƏVVƏL —
// fayl diskə yazılmadan rədd edilir)
// ============================================================
export const uploadLimiter = rateLimit({
  store: new HybridStore("upload"),
  windowMs: 60 * 60 * 1000,
  max: parseInt(process.env.UPLOAD_LIMIT_PER_HOUR || "20", 10),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?._id?.toString() || ipKey(req),
  message: {
    success: false,
    error: "UPLOAD_LIMIT_EXCEEDED",
    message: "Bir saat ərzində çox video yüklədiniz. Bir az sonra yenidən cəhd edin.",
  },
});

const MAX_PENDING_UPLOADS = parseInt(process.env.MAX_PENDING_UPLOADS || "3", 10);

// Eyni provider-in eyni anda emal olunan video sayını məhdudlaşdırır (disk + AI xərci qoruması)
export const limitPendingUploads = async (req, res, next) => {
  try {
    const pending = await Video.countDocuments({
      providerId: req.user._id,
      processingStatus: { $in: ["queued", "processing"] },
    });
    if (pending >= MAX_PENDING_UPLOADS) {
      return res.status(429).json({
        success: false,
        error: "TOO_MANY_PENDING_UPLOADS",
        message: `Hazırda ${pending} videonuz emal olunur. Onlar bitdikdən sonra yenisini yükləyin.`,
      });
    }
    next();
  } catch (err) {
    console.error("limitPendingUploads error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Server xətası." });
  }
};
