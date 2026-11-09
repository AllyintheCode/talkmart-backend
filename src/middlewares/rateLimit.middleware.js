import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import crypto from "node:crypto";
import { getRedisClient } from "../config/redis.js";
import RateBucket from "../models/RateBucket.js";

export class SharedRateStore {
  constructor(prefix) { this.prefix = prefix; this.localKeys = false; }
  init(options) { this.windowMs = options.windowMs; }
  key(key) { return `${this.prefix}:${crypto.createHash("sha256").update(key).digest("hex")}`; }
  async increment(key) {
    const redis = getRedisClient();
    if (redis) {
      const [totalHits, ttl] = await redis.eval(`local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end; return {n,redis.call('PTTL',KEYS[1])}`, 1, this.key(key), this.windowMs);
      return { totalHits, resetTime: new Date(Date.now() + Math.max(0, ttl)) };
    }
    // Shared DB fallback retains abuse protection during a Redis outage.
    const reset = (Math.floor(Date.now() / this.windowMs) + 1) * this.windowMs;
    const id = `${this.key(key)}:${reset}`;
    let bucket;
    try {
      bucket = await RateBucket.findOneAndUpdate({ _id: id }, { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(reset) } }, { upsert: true, returnDocument: "after" });
    } catch (err) {
      if (err.code !== 11000) throw err;
      bucket = await RateBucket.findOneAndUpdate({ _id: id }, { $inc: { count: 1 } }, { returnDocument: "after" });
    }
    return { totalHits: bucket.count, resetTime: new Date(reset) };
  }
  async decrement() {}
  async resetKey(key) { await getRedisClient()?.del(this.key(key)); }
}
const ip = (req) => ipKeyGenerator(req.ip || "127.0.0.1");
const account = (req) => req.user?._id?.toString() || (typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : ip(req));
const limiter = (name, limit, windowMs, keyGenerator) => rateLimit({
  windowMs, limit, keyGenerator, store: new SharedRateStore(`ratelimit:${name}`),
  standardHeaders: "draft-8", legacyHeaders: false,
  handler(req, res) {
    const seconds = Math.max(1, Math.ceil(((req.rateLimit?.resetTime?.getTime() || Date.now() + windowMs) - Date.now()) / 1000));
    res.setHeader("Retry-After", String(seconds));
    res.status(429).json({ success: false, error: "RATE_LIMIT_EXCEEDED", message: "Too many requests" });
  },
});
export const globalLimiter = limiter("public", 300, 60000, ip);
export const authIpLimiter = limiter("auth-ip", 30, 600000, ip);
export const authLimiter = limiter("auth-account", 10, 600000, account);
export const engagementLimiter = limiter("engagement", 30, 60000, account);
export const uploadLimiter = limiter("upload", 15, 600000, account);
export const directUploadControlLimiter = limiter("direct-upload-control", 60, 600000, account);
