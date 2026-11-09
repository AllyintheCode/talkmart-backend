import mongoose from "mongoose";
const schema = new mongoose.Schema({
  providerId: { type: mongoose.Schema.Types.ObjectId, required: true },
  idempotencyKey: { type: String, required: true }, requestHash: { type: String, required: true },
  sourceKey: { type: String, required: true }, storageUploadId: String,
  declaredBytes: { type: Number, required: true }, contentType: { type: String, required: true }, originalExt: String,
  title: String, description: String, price: Number,
  categoryId: { type: mongoose.Schema.Types.ObjectId, required: true }, categoryName: String,
  state: { type: String, enum: ["creating", "uploading", "completing", "completed", "closing", "cancelled", "expired", "failed"], required: true },
  expiresAt: { type: Date, required: true }, lockId: String, lockedUntil: Date,
  quotaBucketId: String, quotaSettled: { type: Boolean, default: false },
  observedBytes: { type: Number, default: 0 }, chargedBytes: Number,
  closeReason: { type: String, enum: ["cancelled", "expired", "failed"] },
  cleanupDone: { type: Boolean, default: false }, purgeAt: Date,
}, { timestamps: true });
schema.index({ providerId: 1, idempotencyKey: 1 }, { unique: true });
schema.index({ providerId: 1, state: 1 });
schema.index({ state: 1, expiresAt: 1, lockedUntil: 1 });
schema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
export default mongoose.models.UploadSession || mongoose.model("UploadSession", schema);
