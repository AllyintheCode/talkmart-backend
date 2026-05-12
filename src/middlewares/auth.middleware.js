import jwt from "jsonwebtoken";
import User from "../models/User.js";

// ============================================================
// verifyToken — Token mütləq tələb olunan route-lar üçün
// ============================================================
export const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ message: "Token tapılmadı." });
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // ✅ OPTİMALLAŞDIRMA: DB sorğusu yalnız tam user objecti lazım olduqda
    const user = await User.findById(decoded.id).select("-password");
    if (!user) {
      return res.status(401).json({ message: "İstifadəçi tapılmadı." });
    }

    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ message: "Token yanlışdır və ya vaxtı keçib." });
  }
};

// ============================================================
// optionalAuth — Token varsa oxu, yoxdursa guest kimi davam et
// ✅ OPTİMALLAŞDIRMA: DB-ə getmirik, JWT payload kifayətdir
// ============================================================
export const optionalAuth = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      req.user = null; // guest
      return next();
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // JWT-dən gələn data kifayətdir (id + role)
    req.user = { _id: decoded.id, role: decoded.role };
    next();
  } catch (err) {
    // Token yanlışdırsa da guest kimi davam et
    req.user = null;
    next();
  }
};

// ============================================================
// requireAuth — Login tələb olunan əməliyyatlar üçün
// ✅ OPTİMALLAŞDIRMA: DB-ə getmirik, JWT payload kifayətdir
// ============================================================
export const requireAuth = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        error: "LOGIN_REQUIRED",
        message: "Bu əməliyyat üçün giriş tələb olunur.",
      });
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // JWT-dən gələn data kifayətdir
    req.user = { _id: decoded.id, role: decoded.role };
    next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      error: "LOGIN_REQUIRED",
      message: "Sessiyanızın vaxtı bitib. Zəhmət olmasa yenidən daxil olun.",
    });
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
