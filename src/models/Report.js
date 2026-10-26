import mongoose from "mongoose";

const ReportSchema = new mongoose.Schema(
  {
    reporterId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    reportedUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    videoId: { type: mongoose.Schema.Types.ObjectId, ref: "Video" },
    reason: { type: String, required: true },
    details: { type: String, default: "" },

    // Audit & Lifecycle sahələri (TM-025)
    status: {
      type: String,
      enum: ["new", "in_progress", "resolved", "rejected"],
      default: "new",
    },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    resolvedAt: { type: Date, default: null },
    adminNote: { type: String, default: "" },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    notificationStatus: { type: String, enum: ["pending", "sending", "sent", "failed"], default: "pending" },
    notificationAttempts: { type: Number, default: 0 },
    notificationNextAt: { type: Date, default: Date.now },
    notificationLease: { type: String, default: null },
    notificationLockedUntil: { type: Date, default: null },
    history: [
      {
        action: { type: String, required: true },
        adminId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        note: { type: String, default: "" },
        at: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

ReportSchema.index({ status: 1, createdAt: -1 });
ReportSchema.index({ notificationStatus: 1, notificationNextAt: 1 });

export default mongoose.models.Report || mongoose.model("Report", ReportSchema);
