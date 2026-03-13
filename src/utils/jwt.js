import jwt from "jsonwebtoken";

export function signAccessToken(payload) {
  if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET .env-də yoxdur");

  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "7d" });
}

export function verifyAccessToken(token) {
  if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET .env-də yoxdur");

  return jwt.verify(token, process.env.JWT_SECRET);
}
