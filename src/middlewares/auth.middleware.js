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
// Feed / Explore / Engagement statusu üçün istifadə olunur.
// req.user = null  →  guest istifadəçi
// ============================================================
export const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      req.user = { role: "guest" }; // guest
      return next();
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select("-password");

    req.user = user || { role: "guest" };
    next();
  } catch (err) {
    // Token yanlışdırsa da guest kimi davam et (bloklamırıq)
    req.user = { role: "guest" };
    next();
  }
};

// ============================================================
// requireAuth — Login tələb olunan əməliyyatlar üçün
// Like / Save / Contact / Kayd et kimi funksiyalar
// Mobil tətbiq bu kodu alıb istifadəçini login ekranına aparır.
// ============================================================
export const requireAuth = async (req, res, next) => {
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
    const user = await User.findById(decoded.id).select("-password");

    if (!user) {
      return res.status(401).json({
        success: false,
        error: "LOGIN_REQUIRED",
        message: "İstifadəçi tapılmadı. Zəhmət olmasa yenidən daxil olun.",
      });
    }

    req.user = user;
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
