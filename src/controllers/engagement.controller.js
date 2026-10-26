import mongoose from "mongoose";
import crypto from "node:crypto";
import Video from "../models/Video.js";
import User from "../models/User.js";
import ViewWindow from "../models/ViewWindow.js";
import { VideoLike, VideoSave } from "../models/VideoInteraction.js";
import { setInteraction } from "../services/engagement.service.js";
import { publicVideoFilter, publicOwnerFilter, canPublishVideo } from "../services/videoState.service.js";
import { parsePagination } from "../utils/pagination.js";

const interaction = (kind) => async (req, res) => {
  const key = kind === "like" ? "liked" : "saved";
  const desired = req.method === "DELETE" ? false : req.body?.[key] ?? true;
  if (typeof desired !== "boolean") return res.status(400).json({ error: "INVALID_STATE" });
  const result = await setInteraction(req.params.id, req.user._id, kind, desired);
  return res.json({ success: true, [key]: result.enabled, [`${kind}Count`]: result.count });
};
export const toggleLike = interaction("like");
export const toggleSave = interaction("save");
const hmac = (value) => {
  const pepper = process.env.OTP_PEPPER;
  if (!pepper || pepper.length < 32) throw new Error("OTP_PEPPER_REQUIRED");
  return crypto.createHmac("sha256", pepper).update(value).digest("hex");
};
export function anonymousViewer(req, res) {
  const cookie = String(req.headers.cookie || "").split(";").map((item) => item.trim()).find((item) => item.startsWith("tm_view="))?.slice(8);
  const [id, expires, signature] = (cookie || "").split(".");
  const expected = hmac(`${id}.${expires}`);
  if (/^[a-f0-9]{32}$/.test(id || "") && Number(expires) > Date.now() && /^[a-f0-9]{64}$/.test(signature || "") && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return id;
  const nextId = crypto.randomBytes(16).toString("hex");
  const expiry = Date.now() + 86400000;
  res.cookie("tm_view", `${nextId}.${expiry}.${hmac(`${nextId}.${expiry}`)}`, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", maxAge: 86400000 });
  return nextId;
}
export async function recordView(req, res) {
  if (typeof req.body?.watchedMs !== "number" || !Number.isFinite(req.body.watchedMs) || req.body.watchedMs < 2000) return res.status(400).json({ error: "VIEW_THRESHOLD", message: "At least 2000 watched milliseconds required" });
  const viewer = req.user ? `user:${req.user._id}` : `guest:${anonymousViewer(req, res)}`;
  const id = hmac(`${req.params.id}:${viewer}`);
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const video = await Video.findOne({ _id: req.params.id, ...publicVideoFilter() }).session(session);
      const owner = video && await User.findById(video.providerId).session(session);
      if (!canPublishVideo(video, owner)) throw Object.assign(new Error("Video unavailable"), { status: 404 });
      result = { counted: false, viewCount: video.viewCount };
      if (String(video.providerId) === String(req.user?._id)) return;
      const existing = await ViewWindow.findById(id).session(session);
      if (existing && existing.expiresAt > new Date()) return;
      await ViewWindow.updateOne({ _id: id }, { $set: { videoId: video._id, userId: req.user?._id || null, expiresAt: new Date(Date.now() + 86400000) } }, { upsert: true, session });
      const updated = await Video.findOneAndUpdate({ _id: video._id, ...publicVideoFilter() }, { $inc: { viewCount: 1 } }, { session, returnDocument: "after" });
      if (!updated) throw new Error("VIDEO_STATE_CHANGED");
      result = { counted: true, viewCount: updated.viewCount };
    });
  } catch (err) { if (err.code !== 11000) throw err; result = { counted: false }; }
  finally { await session.endSession(); }
  return res.json({ success: true, ...result });
}
export async function getEngagement(req, res) {
  const video = await Video.findOne({ _id: req.params.id, ...publicVideoFilter() });
  const owner = video && await User.findById(video.providerId);
  if (!canPublishVideo(video, owner)) return res.status(404).json({ error: "NOT_FOUND" });
  const [liked, saved] = req.user ? await Promise.all([VideoLike.exists({ videoId: video._id, userId: req.user._id }), VideoSave.exists({ videoId: video._id, userId: req.user._id })]) : [false, false];
  return res.json({ success: true, likeCount: video.likeCount, saveCount: video.saveCount, viewCount: video.viewCount, isLiked: !!liked, isSaved: !!saved, isGuest: !req.user });
}
async function listInteractions(req, res, Model, kind) {
  const { page, limit, skip } = parsePagination(req.query, { limit: 15 });
  const other = kind === "like" ? "videosaves" : "videolikes";
  const [result] = await Model.aggregate([
    { $match: { userId: new mongoose.Types.ObjectId(req.user._id) } },
    { $sort: { createdAt: -1, _id: -1 } },
    { $lookup: { from: "videos", localField: "videoId", foreignField: "_id", as: "video" } },
    { $unwind: "$video" }, { $match: publicVideoFilter("video.") },
    { $lookup: { from: "users", localField: "video.providerId", foreignField: "_id", as: "provider" } },
    { $unwind: "$provider" }, { $match: publicOwnerFilter() },
    { $facet: { metadata: [{ $count: "total" }], data: [
      { $skip: skip }, { $limit: limit },
      { $lookup: { from: other, let: { vid: "$video._id" }, pipeline: [{ $match: { $expr: { $and: [{ $eq: ["$videoId", "$$vid"] }, { $eq: ["$userId", new mongoose.Types.ObjectId(req.user._id)] }] } } }, { $limit: 1 }], as: "other" } },
      { $project: { _id: "$video._id", title: "$video.title", description: "$video.description", price: "$video.price", videoUrl: "$video.videoUrl", thumbnail: "$video.thumbnail", categoryId: "$video.categoryId", duration: "$video.duration", likeCount: "$video.likeCount", saveCount: "$video.saveCount", viewCount: "$video.viewCount", createdAt: "$video.createdAt", provider: { _id: "$provider._id", fullName: "$provider.fullName", profileImage: "$provider.profileImage", companyName: "$provider.providerProfile.companyName" }, isLiked: kind === "like" ? { $literal: true } : { $gt: [{ $size: "$other" }, 0] }, isSaved: kind === "save" ? { $literal: true } : { $gt: [{ $size: "$other" }, 0] } } },
    ] } },
  ]).option({ maxTimeMS: 5000 });
  const total = result?.metadata[0]?.total || 0;
  return res.json({ success: true, videos: result?.data || [], total, page, totalPages: Math.ceil(total / limit) });
}
export const getLikedVideos = (req, res) => listInteractions(req, res, VideoLike, "like");
export const getSavedVideos = (req, res) => listInteractions(req, res, VideoSave, "save");
