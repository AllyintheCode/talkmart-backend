import { logger } from "../utils/logger.js";
import Onboarding from "../models/Onboarding.js";
import Category from "../models/Category.js";
import User from "../models/User.js";
import Video from "../models/Video.js";
import WorkerStatus from "../models/WorkerStatus.js";
import Report from "../models/Report.js";
import AuditEvent from "../models/AuditEvent.js";
import { parsePagination, cursorFilter, nextCursor } from "../utils/pagination.js";
import { deleteUserCompletely } from "../services/accountCleanup.service.js";
import { deleteVideoCompletely } from "../services/videoCleanup.service.js";
import { setAdminDecision, canPublishVideo, invalidateVideoCache } from "../services/videoState.service.js";
import { invalidateUserSession } from "../middlewares/auth.middleware.js";
import { getQueueStats } from "../services/videoProcessing.service.js";
import { getMetrics } from "../utils/metrics.js";
import { bumpContentVersion } from "../services/publicContent.service.js";

import { uploadToR2, deleteFromR2 } from "../services/r2Upload.service.js";
import { compressImage } from "../services/compress.service.js";

// ============================
// DASHBOARD STATİSTİKALARI (ADMIN)
// ============================

export const getDashboardStats = async (req, res) => {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // 1. User Metrics
    const totalUsers = await User.countDocuments({ role: "user" });
    const totalProviders = await User.countDocuments({ role: "provider" });
    const newSignupsLast30Days = await User.countDocuments({
      createdAt: { $gte: thirtyDaysAgo }
    });

    // 2. Content & Activity Metrics
    const totalVideos = await Video.countDocuments();
    const activeCategories = await Category.countDocuments({ status: "active" });
    
    // Aggregation for total engagements
    const engagementStats = await Video.aggregate([
      {
        $group: {
          _id: null,
          totalViews: { $sum: "$viewCount" },
          totalLikes: { $sum: "$likeCount" },
          totalSaves: { $sum: "$saveCount" }
        }
      }
    ]);
    const totalEngagements = engagementStats[0] || { totalViews: 0, totalLikes: 0, totalSaves: 0 };

    // 3. Leaderboards
    // Top 5 Videos by Views
    const topVideos = await Video.find()
      .sort({ viewCount: -1 })
      .limit(5)
      .populate("providerId", "fullName email") // Şirkət adını gətirmək
      .select("title viewCount likeCount thumbnail providerId");

    // Top 5 Providers by uploaded videos
    const topProvidersAgg = await Video.aggregate([
      { $group: { _id: "$providerId", videoCount: { $sum: 1 } } },
      { $sort: { videoCount: -1 } },
      { $limit: 5 },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "provider"
        }
      },
      { $unwind: "$provider" },
      {
        $project: {
          _id: 1,
          videoCount: 1,
          fullName: "$provider.fullName",
          email: "$provider.email",
          companyName: "$provider.providerProfile.companyName"
        }
      }
    ]);

    return res.status(200).json({
      success: true,
      stats: {
        users: { totalUsers, totalProviders, newSignupsLast30Days },
        content: { totalVideos, activeCategories, totalEngagements },
        leaderboards: { topVideos, topProviders: topProvidersAgg }
      }
    });

  } catch (err) {
    logger.error("getDashboardStats error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Server xətası." });
  }
};

// ============================
// CATEGORY İDARƏETMƏSİ (ADMIN)
// ============================

// Bütün kateqoriyaları gətir (Active + Inactive)
export const getAllCategories = async (req, res) => {
  try {
    const categories = await Category.find().sort({ createdAt: -1 });
    return res.status(200).json({ success: true, categories });
  } catch (err) {
    logger.error("getAllCategories error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Server xətası." });
  }
};

// Yeni Kateqoriya yarat
export const createCategory = async (req, res) => {
  try {
    const { name, status } = req.body;
    
    if (!name || name.trim() === "") {
      return res.status(400).json({ error: "MISSING_NAME", message: "Kateqoriya adı tələb olunur." });
    }

    const existing = await Category.findOne({ name: name.trim() });
    if (existing) {
      return res.status(409).json({ error: "ALREADY_EXISTS", message: "Bu adda kateqoriya artıq mövcuddur." });
    }

    const category = await Category.create({ 
      name: name.trim(), 
      status: status || "active" 
    });

    await bumpContentVersion("categories");
    return res.status(201).json({ success: true, message: "Kateqoriya yaradıldı", category });
  } catch (err) {
    logger.error("createCategory error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Server xətası." });
  }
};

// Kateqoriyanı yenilə
export const updateCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, status } = req.body;

    const category = await Category.findById(id);
    if (!category) {
      return res.status(404).json({ error: "NOT_FOUND", message: "Kateqoriya tapılmadı." });
    }

    if (name) {
      // Başqa kateqoriya adı ilə çaxışırmı yoxla
      const existing = await Category.findOne({ name: name.trim(), _id: { $ne: id } });
      if (existing) {
         return res.status(409).json({ error: "ALREADY_EXISTS", message: "Bu adda başqa kateqoriya mövcuddur." });
      }
      category.name = name.trim();
    }
    
    if (status) {
      category.status = status;
    }

    await category.save();
    await bumpContentVersion("categories");

    return res.status(200).json({ success: true, message: "Kateqoriya yeniləndi", category });
  } catch (err) {
    logger.error("updateCategory error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Server xətası." });
  }
};

// Kateqoriyanı sil
export const deleteCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const category = await Category.findById(id);
    
    if (!category) {
      return res.status(404).json({ error: "NOT_FOUND", message: "Kateqoriya tapılmadı." });
    }

    await category.deleteOne();
    await bumpContentVersion("categories");

    return res.status(200).json({ success: true, message: "Kateqoriya silindi." });
  } catch (err) {
    logger.error("deleteCategory error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Server xətası." });
  }
};

// ============================
// ONBOARDING İDARƏETMƏSİ (ADMIN)
// ============================


// POST /api/admin/onboarding (Yalnız Admin)
export const createOnboarding = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "MISSING_FILE", message: "Şəkil faylı tələb olunur." });
    }

    const { title, description, order } = req.body;

    if (!title || !description) {
      return res.status(400).json({ error: "MISSING_FIELDS", message: "Başlıq və açıqlama tələb olunur." });
    }

    // R2-yə şəkil yüklə
    const originalSize = req.file.buffer.length;
    const compressed = await compressImage(req.file.buffer);
    const compressedSize = compressed.buffer.length;
    const savedPercent = ((1 - compressedSize / originalSize) * 100).toFixed(1);
    logger.log(`🖼️ Onboarding şəkil sıxışdırma: ${(originalSize / 1024).toFixed(2)}KB → ${(compressedSize / 1024).toFixed(2)}KB (${savedPercent}% azalma)`);

    const { key, url } = await uploadToR2(compressed.buffer, "talkmart/onboarding", compressed.mimetype, compressed.ext);

    const newScreen = await Onboarding.create({
      title,
      description,
      order: order ? parseInt(order) : 0,
      image: url,       // R2 public URL
      publicId: key,    // R2 key (silmək üçün)
    });

    await bumpContentVersion("onboarding");
    return res.status(201).json({ success: true, message: "Onboarding ekranı yaradıldı.", screen: newScreen });
  } catch (err) {
    logger.error("createOnboarding error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Server xətası." });
  }
};

// PUT /api/admin/onboarding/:id (Yalnız Admin)
export const updateOnboarding = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, order } = req.body;

    const screen = await Onboarding.findById(id);
    if (!screen) {
      return res.status(404).json({ error: "NOT_FOUND", message: "Ekran tapılmadı." });
    }

    // Əgər yeni şəkil göndərilibsə
    if (req.file) {
      // Köhnə şəkli R2-dən silirik
      await deleteFromR2(screen.publicId);
      
      // Yeni şəkli R2-yə yükləyirik
      const originalSize = req.file.buffer.length;
      const compressed = await compressImage(req.file.buffer);
      const compressedSize = compressed.buffer.length;
      const savedPercent = ((1 - compressedSize / originalSize) * 100).toFixed(1);
      logger.log(`🖼️ Onboarding şəkil sıxışdırma: ${(originalSize / 1024).toFixed(2)}KB → ${(compressedSize / 1024).toFixed(2)}KB (${savedPercent}% azalma)`);

      const { key, url } = await uploadToR2(compressed.buffer, "talkmart/onboarding", compressed.mimetype, compressed.ext);
      screen.image = url;
      screen.publicId = key;
    }

    if (title) screen.title = title;
    if (description) screen.description = description;
    if (order !== undefined) screen.order = parseInt(order);

    await screen.save();
    await bumpContentVersion("onboarding");

    return res.status(200).json({ success: true, message: "Onboarding ekranı yeniləndi.", screen });
  } catch (err) {
    logger.error("updateOnboarding error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Server xətası." });
  }
};

// DELETE /api/admin/onboarding/:id (Yalnız Admin)
export const deleteOnboarding = async (req, res) => {
  try {
    const { id } = req.params;
    const screen = await Onboarding.findById(id);

    if (!screen) {
      return res.status(404).json({ error: "NOT_FOUND", message: "Ekran tapılmadı." });
    }

    // R2-dən şəkli silirik
    await deleteFromR2(screen.publicId);

    // Bazadan silirik
    await screen.deleteOne();
    await bumpContentVersion("onboarding");

    return res.status(200).json({ success: true, message: "Onboarding ekranı silindi." });
  } catch (err) {
    logger.error("deleteOnboarding error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Server xətası." });
  }
};

// ============================
// İSTİFADƏÇİ İDARƏETMƏSİ (ADMIN)
// ============================

// GET /api/admin/users (Yalnız Admin)
// Məhdud səhifələmə və cursor ilə istifadəçiləri gətirir
export const getAllUsers = async (req, res) => {
  const { page, limit, skip, search } = parsePagination(req.query);
  const filter = { accountStatus: { $ne: "deleting" } };
  if (req.query.role) filter.role = req.query.role;
  if (req.query.verified !== undefined) filter["providerProfile.verified"] = req.query.verified === "true";
  if (search) filter.fullName = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const [users, total] = await Promise.all([
    User.find({ $and: [filter, cursorFilter(req.query.cursor)] }).select("fullName role profileImage emailVerified isBlocked accountStatus providerProfile.verified createdAt")
      .sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).maxTimeMS(5000).lean(),
    User.countDocuments(filter).maxTimeMS(5000),
  ]);
  return res.json({ success: true, users, count: users.length, total, page, totalPages: Math.ceil(total / limit), nextCursor: nextCursor(users, limit) });
};
export const blockUser = async (req, res) => {
  const user = await User.findOneAndUpdate({ _id: req.params.id, role: { $ne: "admin" }, isBlocked: false },
    { $set: { isBlocked: true }, $inc: { sessionVersion: 1 } }, { returnDocument: "after" });
  if (!user) return res.status(404).json({ error: "NOT_FOUND", message: "Account unavailable" });
  await invalidateUserSession(user._id);
  await invalidateVideoCache();
  await AuditEvent.create({ actorId: req.user._id, targetId: user._id, action: "account_block", reason: req.body.reason || "" });
  return res.json({ success: true, message: "Account blocked" });
};
export const unblockUser = async (req, res) => {
  const user = await User.findOneAndUpdate({ _id: req.params.id, isBlocked: true, accountStatus: { $ne: "deleting" } },
    { $set: { isBlocked: false }, $inc: { sessionVersion: 1 } }, { returnDocument: "after" });
  if (!user) return res.status(404).json({ error: "NOT_FOUND" });
  await invalidateUserSession(user._id);
  await invalidateVideoCache();
  await AuditEvent.create({ actorId: req.user._id, targetId: user._id, action: "account_unblock", reason: req.body.reason || "" });
  return res.json({ success: true, message: "Account unblocked" });
};
export const verifyProvider = async (req, res) => {
  if (typeof req.body.verified !== "boolean") return res.status(400).json({ error: "INVALID_VERIFIED" });
  const user = await User.findOneAndUpdate({ _id: req.params.id, role: "provider", accountStatus: { $ne: "deleting" } },
    { $set: { "providerProfile.verified": req.body.verified }, $inc: { sessionVersion: 1 } }, { returnDocument: "after", runValidators: true });
  if (!user) return res.status(404).json({ error: "NOT_FOUND" });
  await invalidateUserSession(user._id);
  await AuditEvent.create({ actorId: req.user._id, targetId: user._id, action: req.body.verified ? "provider_verify" : "provider_unverify", reason: req.body.reason || "" });
  return res.json({ success: true, verified: user.providerProfile.verified });
};
export const deleteUser = async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: "NOT_FOUND" });
  if (user.role === "admin") return res.status(403).json({ error: "FORBIDDEN" });
  await deleteUserCompletely(user._id);
  return res.status(202).json({ success: true, message: "Account deletion queued" });
};
async function listVideos(req, res, reviewOnly = false) {
  const { page, limit, skip, search } = parsePagination(req.query);
  const filter = reviewOnly ? { moderationStatus: "review", status: { $ne: "deleting" } } : {};
  for (const field of ["status", "moderationStatus", "processingStatus"]) if (req.query[field]) filter[field] = req.query[field];
  if (search) filter.$text = { $search: search };
  const [videos, total] = await Promise.all([
    Video.find({ $and: [filter, cursorFilter(req.query.cursor)] }).populate("providerId", "fullName").populate("categoryId", "name")
      .sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).maxTimeMS(5000).lean(),
    Video.countDocuments(filter).maxTimeMS(5000),
  ]);
  return res.json({ success: true, videos, total, page, count: videos.length, totalPages: Math.ceil(total / limit), nextCursor: nextCursor(videos, limit) });
}
export const getVideosForReview = (req, res) => listVideos(req, res, true);
export const getAllVideos = (req, res) => listVideos(req, res);
export const adminDeleteVideo = async (req, res) => {
  const video = await deleteVideoCompletely(req.params.id);
  if (!video) return res.status(404).json({ error: "NOT_FOUND" });
  await AuditEvent.create({ actorId: req.user._id, targetId: video._id, action: "video_delete" });
  return res.status(202).json({ success: true, deletedVideoId: video._id });
};
export const adminUpdateVideoStatus = async (req, res) => {
  if (!["active", "inactive"].includes(req.body.status)) return res.status(400).json({ error: "INVALID_STATUS" });
  const video = await Video.findOne({ _id: req.params.id, status: { $ne: "deleting" } });
  if (!video) return res.status(404).json({ error: "NOT_FOUND" });
  const owner = await User.findById(video.providerId);
  const wantsActive = req.body.status === "active";
  if (wantsActive && !canPublishVideo({ ...video.toObject(), visibility: "public" }, owner)) {
    return res.status(409).json({ error: "VIDEO_NOT_PUBLISHABLE", message: "Video must be ready and approved" });
  }
  const updated = await Video.findOneAndUpdate({ _id: video._id, decisionVersion: video.decisionVersion, status: { $ne: "deleting" }, processingStatus: video.processingStatus },
    { $set: { status: req.body.status, visibility: wantsActive ? "public" : "hidden" }, $inc: { decisionVersion: 1 } }, { returnDocument: "after", runValidators: true });
  if (!updated) return res.status(409).json({ error: "STATE_CHANGED" });
  await invalidateVideoCache();
  await AuditEvent.create({ actorId: req.user._id, targetId: video._id, action: `video_${req.body.status}` });
  return res.json({ success: true, video: updated });
};
export const moderateVideo = async (req, res) => {
  if (req.body.feedback !== undefined && (typeof req.body.feedback !== "string" || req.body.feedback.length > 2000)) return res.status(400).json({ error: "INVALID_FEEDBACK" });
  const video = await setAdminDecision(req.params.id, req.body.action, req.user._id, req.body.feedback || "");
  if (!video) return res.status(404).json({ error: "NOT_FOUND" });
  return res.json({ success: true, video });
};
export const getReports = async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.overdue === "true") { filter.status = { $in: ["new", "in_progress"] }; filter.createdAt = { $lt: new Date(Date.now() - 86400000) }; }
  const [reports, total] = await Promise.all([Report.find({ $and: [filter, cursorFilter(req.query.cursor)] }).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).maxTimeMS(5000).lean(), Report.countDocuments(filter).maxTimeMS(5000)]);
  return res.json({ success: true, reports, total, page, totalPages: Math.ceil(total / limit), nextCursor: nextCursor(reports, limit) });
};
export const updateReport = async (req, res) => {
  const { status, note = "", assignedTo } = req.body;
  if (!["new", "in_progress", "resolved", "rejected"].includes(status) || typeof note !== "string" || note.length > 2000 || (["resolved", "rejected"].includes(status) && !note.trim())) return res.status(400).json({ error: "INVALID_REPORT_DECISION" });
  if (assignedTo && !await User.exists({ _id: assignedTo, role: "admin", isBlocked: false })) return res.status(400).json({ error: "INVALID_ASSIGNEE" });
  const closed = ["resolved", "rejected"].includes(status);
  const report = await Report.findByIdAndUpdate(req.params.id, {
    $set: { status, adminNote: note, assignedTo: assignedTo || req.user._id, resolvedBy: closed ? req.user._id : null, resolvedAt: closed ? new Date() : null },
    $push: { history: { action: status, adminId: req.user._id, note, at: new Date() } },
  }, { returnDocument: "after", runValidators: true });
  if (!report) return res.status(404).json({ error: "NOT_FOUND" });
  return res.json({ success: true, report });
};
export const getOperations = async (req, res) => {
  const [queue, reportBacklog, notificationFailures, staleLeases, deleting] = await Promise.all([
    getQueueStats(), Report.countDocuments({ status: { $in: ["new", "in_progress"] } }),
    Report.countDocuments({ notificationStatus: "failed" }),
    Video.countDocuments({ processingStatus: "processing", lockedUntil: { $lt: new Date() } }),
    Video.countDocuments({ status: "deleting" }),
  ]);
  const workers = await WorkerStatus.find().lean();
  return res.json({ success: true, workers, queue, reportBacklog, notificationFailures, staleLeases, deleting, latency: getMetrics(), memory: process.memoryUsage() });
};
export const retryVideo = async (req, res) => {
  const video = await Video.findOneAndUpdate({ _id: req.params.id, processingStatus: "failed", stagingKey: { $ne: "" }, status: { $ne: "deleting" } },
    { $set: { processingStatus: "queued", attempt: 0, nextAttemptAt: new Date(), workerId: null, lockedUntil: null } }, { returnDocument: "after" });
  if (!video) return res.status(409).json({ error: "NOT_RETRYABLE" });
  await AuditEvent.create({ actorId: req.user._id, targetId: video._id, action: "video_retry" });
  return res.status(202).json({ success: true, video });
};
export const retryReportNotification = async (req, res) => {
  const report = await Report.findOneAndUpdate({ _id: req.params.id, notificationStatus: "failed" }, { $set: { notificationStatus: "pending", notificationAttempts: 0, notificationNextAt: new Date() } }, { returnDocument: "after" });
  if (!report) return res.status(409).json({ error: "NOT_RETRYABLE" });
  return res.status(202).json({ success: true, report });
};
