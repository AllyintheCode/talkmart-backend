import crypto from "node:crypto";
import Report from "../models/Report.js";
import { sendAdminNotification } from "../utils/email.js";
import { logger } from "../utils/logger.js";

export async function deliverNextReportNotification() {
  await Report.updateMany({ notificationStatus: "sending", notificationAttempts: { $gte: 8 }, notificationLockedUntil: { $lte: new Date() } }, { $set: { notificationStatus: "failed", notificationLease: null, notificationLockedUntil: null } });
  const lease = crypto.randomUUID();
  const report = await Report.findOneAndUpdate({
    notificationAttempts: { $lt: 8 },
    $or: [
      { notificationStatus: "pending", notificationNextAt: { $lte: new Date() } },
      { notificationStatus: "sending", notificationLockedUntil: { $lte: new Date() } },
    ],
  }, { $set: { notificationStatus: "sending", notificationLease: lease, notificationLockedUntil: new Date(Date.now() + 120000) }, $inc: { notificationAttempts: 1 } }, { returnDocument: "after" });
  if (!report) return false;
  try {
    // Avoid putting personal information or report text into SMTP/provider logs.
    await sendAdminNotification("New report", `Report ${report._id} is awaiting review in the admin API.`);
    await Report.updateOne({ _id: report._id, notificationLease: lease }, { $set: { notificationStatus: "sent", notificationLease: null, notificationLockedUntil: null } });
  } catch (err) {
    logger.warn("report_notification_failed", err);
    await Report.updateOne({ _id: report._id, notificationLease: lease }, { $set: {
      notificationStatus: report.notificationAttempts >= 8 ? "failed" : "pending",
      notificationLease: null, notificationLockedUntil: null,
      notificationNextAt: new Date(Date.now() + Math.min(3600000, 30000 * 2 ** report.notificationAttempts)),
    } });
  }
  return true;
}
