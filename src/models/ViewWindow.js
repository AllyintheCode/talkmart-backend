import mongoose from "mongoose";
const schema = new mongoose.Schema({
  _id: String,
  videoId: { type: mongoose.Schema.Types.ObjectId, ref: "Video", required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  expiresAt: { type: Date, required: true },
});
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
schema.index({ videoId: 1 });
schema.index({ userId: 1 });
export default mongoose.models.ViewWindow || mongoose.model("ViewWindow", schema);
