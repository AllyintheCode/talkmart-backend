import jwt from "jsonwebtoken";
import User from "../models/User.js";

// JWT token yoxla
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

// Yalnız provider girə bilər
export const providerOnly = (req, res, next) => {
  if (req.user?.role !== "provider") {
    return res.status(403).json({ message: "Bu əməliyyat yalnız provider üçündür." });
  }
  next();
};

// Yalnız admin girə bilər
export const adminOnly = (req, res, next) => {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ message: "Bu əməliyyat yalnız admin üçündür." });
  }
  next();
};
