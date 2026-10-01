import mongoose from "mongoose";

const ReportSchema = new mongoose.Schema({
  reporterId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  reportedUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  videoId: { type: mongoose.Schema.Types.ObjectId, ref: "Video" },
  reason: { type: String, required: true },
  details: { type: String }
}, { timestamps: true });

export default mongoose.models.Report || mongoose.model("Report", ReportSchema);
