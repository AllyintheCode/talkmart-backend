import ViewWindow from "../models/ViewWindow.js";
import User from "../models/User.js";
import Otp from "../models/Otp.js";
import Video from "../models/Video.js";
import Report from "../models/Report.js";
import { VideoLike, VideoSave, VideoView } from "../models/VideoInteraction.js";
import { deleteFromR2 } from "./r2Upload.service.js";
import { cleanupVideoResources, markVideoDeleting } from "./videoCleanup.service.js";
import AuditEvent from "../models/AuditEvent.js";
import { delCache, delCachePattern } from "../config/redis.js";
import UploadSession from "../models/UploadSession.js";
import { cleanupOwnerDirectUploads } from "./directUpload.service.js";

export async function deleteUserCompletely(userId) {
  const user = await User.findOneAndUpdate({ _id: userId }, { $set: { accountStatus: "deleting", isBlocked: true }, $inc: { sessionVersion: 1 } }, { returnDocument: "after" });
  if (!user) return null;
  await Video.updateMany({ providerId: user._id, status: { $ne: "deleting" } }, { $set: { status: "deleting", processingStatus: "deleting", workerId: null, lockedUntil: null }, $inc: { decisionVersion: 1 } });
  await Promise.all([delCache(`user:session:${user._id}`), delCachePattern("feed:*"), delCachePattern("categories:top:*")]);
  return user;
}
export async function cleanupDeletedAccount(user) {
  if (!await cleanupOwnerDirectUploads(user._id)) return;
  await deleteFromR2(user.profileImagePublicId);
  await Otp.deleteMany({ email: user.email });
  const videos = await Video.find({ providerId: user._id }).limit(50);
  for (const video of videos) { await markVideoDeleting(video._id); await cleanupVideoResources(video); }
  if (await Video.exists({ providerId: user._id })) return;
  await VideoLike.deleteMany({ userId: user._id });
  await VideoSave.deleteMany({ userId: user._id });
  await VideoView.deleteMany({ userId: user._id });
  await ViewWindow.deleteMany({ userId: user._id });
  await User.updateMany({ blockedUsers: user._id }, { $pull: { blockedUsers: user._id } });
  await Report.updateMany({ $or: [{ reporterId: user._id }, { reportedUserId: user._id }] }, { $set: { details: "[anonymized]", reason: "[anonymized]", reporterId: null, reportedUserId: null } });
  await Report.updateMany({ "history.adminId": user._id }, { $set: { "history.$[entry].adminId": null } }, { arrayFilters: [{ "entry.adminId": user._id }] });
  await Report.updateMany({ resolvedBy: user._id }, { $set: { resolvedBy: null } });
  await Report.updateMany({ assignedTo: user._id }, { $set: { assignedTo: null } });
  await AuditEvent.updateMany({ $or: [{ actorId: user._id }, { targetId: user._id }] }, { $set: { actorId: null, targetId: null, reason: "[anonymized]" } });
  await UploadSession.deleteMany({ providerId: user._id });
  await User.deleteOne({ _id: user._id, accountStatus: "deleting" });
}
