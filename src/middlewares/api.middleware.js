import crypto from "node:crypto";
import { paginationSchema, explorePaginationSchema, isValidObjectId, cursorFilter } from "../utils/pagination.js";
import { logger } from "../utils/logger.js";

export function apiContract(req, res, next) {
  req.requestId = crypto.randomUUID();
  res.setHeader("X-Request-Id", req.requestId);
  const json = res.json.bind(res);
  res.json = (payload) => {
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      if (res.statusCode >= 400) {
        const original = payload.error;
        const code = typeof original === "string" && /^[A-Z][A-Z_\d]+$/.test(original) ? original : original?.code || `HTTP_${res.statusCode}`;
        const message = res.statusCode >= 500 ? "Server error" : payload.message || original?.message || original || "Request failed";
        payload = { success: false, data: null, error: { code, message: String(message) }, message: String(message), meta: { requestId: req.requestId } };
      } else {
        const { success, meta, ...data } = payload;
        payload = { ...payload, success: success ?? true, data, error: null, meta: { ...meta, requestId: req.requestId } };
      }
    }
    return json(payload);
  };
  next();
}
const enums = {
  sort: ["newest", "trending", "price_low", "price_high"],
  moderationStatus: ["pending", "approved", "rejected", "review"],
  processingStatus: ["uploaded", "queued", "processing", "ready", "failed", "deleting"],
  role: ["guest", "user", "provider", "admin"], verified: ["true", "false"], overdue: ["true", "false"],
  status: ["active", "inactive", "deleting", "new", "in_progress", "resolved", "rejected"],
};
export function validateQuery(req, res, next) {
  const invalid = (message) => res.status(400).json({ error: "INVALID_QUERY", message });
  for (const [key, value] of Object.entries(req.query)) {
    if (typeof value !== "string" || value.length > (key === "cursor" ? 300 : 100)) return invalid(`Invalid ${key}`);
    if (enums[key] && !enums[key].includes(value)) return invalid(`Invalid ${key}`);
    if (["categoryId", "providerId"].includes(key) && !isValidObjectId(value)) return invalid(`Invalid ${key}`);
    if (["minPrice", "maxPrice"].includes(key) && (!value.trim() || !Number.isFinite(Number(value)) || Number(value) < 0)) return invalid(`Invalid ${key}`);
  }
  if (req.query.minPrice !== undefined && req.query.maxPrice !== undefined && Number(req.query.minPrice) > Number(req.query.maxPrice)) return invalid("Invalid price range");
  if (req.query.cursor) {
    try { cursorFilter(req.query.cursor); } catch { return invalid("Invalid cursor"); }
    if (req.query.sort && req.query.sort !== "newest") return invalid("Cursor requires newest sort");
    if (Number(req.query.page || 1) !== 1) return invalid("Cursor cannot be combined with page");
  }
  const schema = /^\/videos\/explore\/?$/i.test(req.path) ? explorePaginationSchema : paginationSchema;
  const pagination = schema.safeParse(req.query);
  if (!pagination.success || (pagination.data.page - 1) * pagination.data.limit > 10000) return invalid("Invalid pagination; use a narrower filter");
  next();
}
export function validateId(req, res, next, value) {
  if (!isValidObjectId(value)) return res.status(400).json({ error: "INVALID_ID", message: "Invalid identifier" });
  next();
}
export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  logger.error("request_failed", { requestId: req.requestId }, err);
  const status = err.status || (err.code === 11000 ? 409 : ["CastError", "ValidationError"].includes(err.name) ? 400 : err.code === "LIMIT_FILE_SIZE" ? 413 : 500);
  return res.status(status).json({ error: err.code && typeof err.code === "string" ? err.code : `HTTP_${status}`, message: status < 500 ? err.message : "Server error" });
}
