import mongoose from "mongoose";
const schema = new mongoose.Schema({
  actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  targetId: { type: mongoose.Schema.Types.ObjectId, default: null },
  action: { type: String, required: true },
  reason: { type: String, maxlength: 2000, default: "" },
}, { timestamps: true });
schema.index({ targetId: 1, createdAt: -1 });
export default mongoose.models.AuditEvent || mongoose.model("AuditEvent", schema);
