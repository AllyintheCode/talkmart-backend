import mongoose from "mongoose";
const schema = new mongoose.Schema({ _id: String, running: Number, latency: mongoose.Schema.Types.Mixed, memory: mongoose.Schema.Types.Mixed, heartbeatAt: Date });
schema.index({ heartbeatAt: 1 }, { expireAfterSeconds: 86400 });
export default mongoose.models.WorkerStatus || mongoose.model("WorkerStatus", schema);
