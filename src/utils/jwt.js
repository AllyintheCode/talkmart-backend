import jwt from "jsonwebtoken";

// payload: { id: "...", role: "user|provider|admin" }
export function signAccessToken(payload) {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET .env-də yoxdur");
  }

  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: "7d", // istəsən "1d" elə
  });
}
