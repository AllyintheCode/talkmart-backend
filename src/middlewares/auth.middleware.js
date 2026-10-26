import User from "../models/User.js";
import { verifyAccessToken } from "../utils/jwt.js";
import { delCache } from "../config/redis.js";

/**
 * Vahid sessiya və token yoxlama xidməti (TM-004, TM-005)
 * - Yalnız typ === 'access' tokenləri qəbul edir (reset token qəbul edilmir)
 * - Bloklanmış istifadəçiləri dərhal rədd edir (isBlocked)
 * - sessionVersion yoxlayır (parol dəyişəndə köhnə tokenlər etibarsız olur)
 * - Hesabın cari vəziyyətini hər sorğuda DB-dən yoxlayır
 */
export const validateAccessSession = async (req) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { error: "TOKEN_MISSING", status: 401, message: "Token tapılmadı." };
  }

  const token = authHeader.split(" ")[1];
  let decoded;
  try {
    decoded = verifyAccessToken(token);
  } catch (err) {
    if (err.message === "INVALID_TOKEN_TYPE") {
      return {
        error: "INVALID_TOKEN_TYPE",
        status: 401,
        message: "Bu əməliyyat üçün yalnız əsas giriş tokeni (access token) istifadə edilə bilər.",
      };
    }
    return {
      error: "TOKEN_EXPIRED",
      status: 401,
      message: "Sessiyanızın vaxtı bitib. Zəhmət olmasa yenidən daxil olun.",
    };
  }

  const userId = decoded.id || decoded._id || decoded.userId;
  if (!userId) {
    return { error: "INVALID_PAYLOAD", status: 401, message: "Token strukturu yanlışdır." };
  }

  // Read authoritative state on every request; cache invalidation can race a block.
  const user = await User.findById(userId)
    .select("role fullName email phone emailVerified isBlocked accountStatus sessionVersion providerProfile")
    .lean();
  if (!user || user.accountStatus === "deleting") {
    return { error: "USER_NOT_FOUND", status: 401, message: "Account unavailable" };
  }

  // 2. Bloklanma yoxlanışı (TM-005)
  if (user.isBlocked || !user.emailVerified) {
    return {
      error: "ACCOUNT_BLOCKED",
      status: 403,
      message: "Hesabınız admin tərəfindən bloklanmışdır. Əlaqə üçün dəstək xidmətinə müraciət edin.",
    };
  }

  // 3. Sessiya versiyası yoxlanışı (Parol yenilənəndə köhnə tokenləri sıradan çıxarır)
  if (decoded.sv !== (user.sessionVersion ?? 1)) {
    return {
      error: "SESSION_REVOKED",
      status: 401,
      message: "Şifrəniz və ya təhlükəsizlik parametrləriniz dəyişdirildiyi üçün yenidən daxil olun.",
    };
  }

  return { user };
};

// ============================================================
// verifyToken — Tam məlumatlı user obyekti tələb edən route-lar
// ============================================================
export const verifyToken = async (req, res, next) => {
  const result = await validateAccessSession(req);
  if (result.error) {
    return res.status(result.status).json({
      success: false,
      error: result.error,
      message: result.message,
    });
  }
  req.user = result.user;
  next();
};

// ============================================================
// requireAuth — Login tələb olunan bütün standart route-lar
// ============================================================
export const requireAuth = async (req, res, next) => {
  const result = await validateAccessSession(req);
  if (result.error) {
    return res.status(result.status).json({
      success: false,
      error: result.error,
      message: result.message,
    });
  }
  req.user = result.user;
  next();
};

// ============================================================
// optionalAuth — Token varsa oxu, yoxdursa guest kimi davam et
// ============================================================
export const optionalAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    req.user = null;
    return next();
  }

  const result = await validateAccessSession(req);
  req.user = result.user || null;
  next();
};

// ============================================================
// providerOnly — Yalnız provider roluna malik istifadəçilər
// ============================================================
export const providerOnly = (req, res, next) => {
  if (req.user?.role !== "provider") {
    return res.status(403).json({
      success: false,
      error: "FORBIDDEN",
      message: "Bu əməliyyat yalnız providerlər üçündür.",
    });
  }
  next();
};

export const verifiedProviderOnly = (req, res, next) => {
  if (req.user?.role !== "provider") {
    return res.status(403).json({
      success: false,
      error: "FORBIDDEN",
      message: "Bu əməliyyat yalnız providerlər üçündür.",
    });
  }
  if (!req.user?.emailVerified || req.user?.providerProfile?.verified !== true) {
    return res.status(403).json({
      success: false,
      error: "PROVIDER_NOT_VERIFIED",
      message: "Video yükləmək üçün provider hesabınız admin tərəfindən təsdiqlənməlidir.",
    });
  }
  next();
};

export async function invalidateUserSession(userId) {
  await delCache(`user:session:${userId}`);
}

export async function bumpSessionVersion(user) {
  user.sessionVersion = (user.sessionVersion || 1) + 1;
  await user.save();
  await invalidateUserSession(user._id);
  return user.sessionVersion;
}

// ============================================================
// adminOnly — Yalnız admin roluna malik istifadəçilər
// ============================================================
export const adminOnly = (req, res, next) => {
  if (req.user?.role !== "admin") {
    return res.status(403).json({
      success: false,
      error: "FORBIDDEN",
      message: "Bu əməliyyat yalnız adminlər üçündür.",
    });
  }
  next();
};
