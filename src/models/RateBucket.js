import mongoose from "mongoose";
const schema = new mongoose.Schema({
  _id: String, count: { type: Number, default: 0 }, expiresAt: Date,
});
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export default mongoose.models.RateBucket || mongoose.model("RateBucket", schema);
