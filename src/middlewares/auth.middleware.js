import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import User from "../models/User.js";
import { getCache, setCache, delCache } from "../config/redis.js";

// ============================================================
// Auth vəziyyəti (mövcuddur? bloklanıb? rol? şifrə nə vaxt dəyişib?)
// Redis-də 60 saniyə keşlənir ki, hər sorğu DB-yə getməsin.
// Block / unblock / silmə / şifrə sıfırlama zamanı invalidateAuthCache çağırılır.
// ============================================================
const AUTH_CACHE_TTL = 60;
const authCacheKey = (id) => `auth:user:${id}`;

export const invalidateAuthCache = (userId) => delCache(authCacheKey(String(userId)));

const getAuthState = async (userId) => {
  if (!userId || !mongoose.isValidObjectId(userId)) return null;

  const key = authCacheKey(userId);
  const cached = await getCache(key);
  if (cached) return cached.exists ? cached : null;

  const u = await User.findById(userId).select("role isBlocked passwordChangedAt").lean();
  const state = u
    ? {
        exists: true,
        role: u.role,
        isBlocked: !!u.isBlocked,
        // saniyə ilə (JWT iat ilə müqayisə üçün)
        pwdAt: u.passwordChangedAt ? Math.floor(new Date(u.passwordChangedAt).getTime() / 1000) : 0,
      }
    : { exists: false };

  await setCache(key, state, AUTH_CACHE_TTL);
  return state.exists ? state : null;
};

/**
 * Bearer token-i yoxlayır və istifadəçinin CARİ vəziyyətini DB/keşdən oxuyur.
 * @returns {Promise<{ user?: { _id: string, role: string }, reason?: string }>}
 */
const resolveUser = async (authHeader) => {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return { reason: "NO_TOKEN" };

  let decoded;
  try {
    decoded = jwt.verify(authHeader.split(" ")[1], process.env.JWT_SECRET);
  } catch {
    return { reason: "INVALID_TOKEN" };
  }

  // Xüsusi təyinatlı tokenlər (məs. reset_password) access token kimi qəbul edilmir
  if (decoded.purpose) return { reason: "INVALID_TOKEN" };

  const userId = String(decoded.id || decoded._id || decoded.userId || "");
  const state = await getAuthState(userId);

  if (!state) return { reason: "USER_NOT_FOUND" };
  if (state.isBlocked) return { reason: "ACCOUNT_BLOCKED" };
  // Şifrə sıfırlanandan əvvəl verilmiş tokenlər etibarsızdır
  if (state.pwdAt && (decoded.iat || 0) < state.pwdAt) return { reason: "TOKEN_REVOKED" };

  // Rol JWT-dən yox, DB-dən götürülür (rol dəyişikliyi dərhal qüvvəyə minir)
  return { user: { _id: userId, role: state.role } };
};

const reasonMessages = {
  NO_TOKEN: "Bu əməliyyat üçün giriş tələb olunur.",
  INVALID_TOKEN: "Sessiyanızın vaxtı bitib. Zəhmət olmasa yenidən daxil olun.",
  USER_NOT_FOUND: "Hesab tapılmadı. Zəhmət olmasa yenidən daxil olun.",
  ACCOUNT_BLOCKED: "Hesabınız admin tərəfindən bloklanmışdır. Ətraflı məlumat üçün bizimlə əlaqə saxlayın.",
  TOKEN_REVOKED: "Şifrəniz dəyişdirilib. Zəhmət olmasa yenidən daxil olun.",
};

const serverError = (res, err) => {
  console.error("Auth middleware xətası:", err);
  return res.status(500).json({ success: false, error: "SERVER_ERROR", message: "Server xətası." });
};

// ============================================================
// verifyToken — Token mütləq tələb olunan route-lar üçün (provider/admin)
// ============================================================
export const verifyToken = async (req, res, next) => {
  try {
    const { user, reason } = await resolveUser(req.headers.authorization);
    if (!user) {
      return res.status(401).json({ message: reasonMessages[reason], reason });
    }
    req.user = user;
    next();
  } catch (err) {
    return serverError(res, err);
  }
};

// ============================================================
// optionalAuth — Token varsa və etibarlıdırsa oxu, yoxdursa guest kimi davam et
// ============================================================
export const optionalAuth = async (req, res, next) => {
  try {
    const { user } = await resolveUser(req.headers.authorization);
    req.user = user || null;
    next();
  } catch (err) {
    return serverError(res, err);
  }
};

// ============================================================
// requireAuth — Login tələb olunan əməliyyatlar üçün
// Mobil tətbiq LOGIN_REQUIRED görüb login ekranına yönləndirir
// ============================================================
export const requireAuth = async (req, res, next) => {
  try {
    const { user, reason } = await resolveUser(req.headers.authorization);
    if (!user) {
      return res.status(401).json({
        success: false,
        error: "LOGIN_REQUIRED",
        reason,
        message: reasonMessages[reason],
      });
    }
    req.user = user;
    next();
  } catch (err) {
    return serverError(res, err);
  }
};

// ============================================================
// providerOnly — Yalnız provider girə bilər
// ============================================================
export const providerOnly = (req, res, next) => {
  if (req.user?.role !== "provider") {
    return res.status(403).json({ message: "Bu əməliyyat yalnız provider üçündür." });
  }
  next();
};

// ============================================================
// adminOnly — Yalnız admin girə bilər
// ============================================================
export const adminOnly = (req, res, next) => {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ message: "Bu əməliyyat yalnız admin üçündür." });
  }
  next();
};
