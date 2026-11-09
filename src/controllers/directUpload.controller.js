import { initDirectUpload, getDirectUpload, completeDirectUpload, cancelDirectUpload } from "../services/directUpload.service.js";
import { directError } from "../services/directUploadStorage.service.js";
import { logger } from "../utils/logger.js";
const reply = async (res, work, initial = false) => {
  res.setHeader("Cache-Control", "private, no-store");
  try {
    const result = await work();
    return res.status(initial && !result.replayed ? 201 : 200).json({ success: true, ...result });
  } catch (error) {
    if (!error.status) { logger.warn("direct_upload_unavailable", error); error = directError(503, "UPLOAD_UNAVAILABLE"); }
    if ([429, 503].includes(error.status)) res.setHeader("Retry-After", error.status === 429 ? "30" : "3");
    throw error;
  }
};
export const initUpload = (req, res) => reply(res, () => initDirectUpload(req.user, req.get("Idempotency-Key"), req.body), true);
export const uploadStatus = (req, res) => reply(res, () => getDirectUpload(req.user, req.params.uploadSessionId));
export const completeUpload = (req, res) => {
  if (!req.body || Object.keys(req.body).length !== 1 || typeof req.body.sessionId !== "string") return res.status(400).json({ error: "INVALID_UPLOAD_SESSION" });
  return reply(res, () => completeDirectUpload(req.user, req.body.sessionId), true);
};
export const cancelUpload = (req, res) => reply(res, () => cancelDirectUpload(req.user, req.params.uploadSessionId));
