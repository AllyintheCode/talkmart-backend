import jwt from "jsonwebtoken";
const issuer = "talkmart";
const audiences = { access: "talkmart-api", password_reset: "talkmart-reset" };
const secret = (type) => {
  const value = process.env[type === "access" ? "JWT_ACCESS_SECRET" : "JWT_RESET_SECRET"] || process.env.JWT_SECRET;
  if (!value || value.length < 32) throw new Error("JWT_SECRET_REQUIRED");
  return value;
};
const sign = (payload, type, expiresIn) => jwt.sign({ ...payload, typ: type }, secret(type), {
  algorithm: "HS256", issuer, audience: audiences[type], expiresIn,
});
const verify = (token, type) => {
  const decoded = jwt.verify(token, secret(type), {
    algorithms: ["HS256"], issuer, audience: audiences[type],
  });
  if (decoded.typ !== type || !/^[a-f\d]{24}$/i.test(decoded.id || "") ||
      !Number.isInteger(decoded.exp) || !Number.isInteger(decoded.iat) ||
      (type === "access" && (!Number.isInteger(decoded.sv) || decoded.sv < 1)) ||
      (type === "password_reset" && typeof decoded.jti !== "string")) {
    throw new Error("INVALID_TOKEN_TYPE");
  }
  return decoded;
};
export const signAccessToken = (p) => sign({ id: String(p.id || p._id), sv: p.sv ?? p.sessionVersion ?? 1 }, "access", "7d");
export const signPasswordResetToken = (p) => sign({ id: String(p.id || p._id), jti: p.jti }, "password_reset", "15m");
export const verifyAccessToken = (token) => verify(token, "access");
export const verifyPasswordResetToken = (token) => verify(token, "password_reset");
