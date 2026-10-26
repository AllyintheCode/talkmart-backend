import ContentVersion from "../models/ContentVersion.js";
import { delCache, delCachePattern } from "../config/redis.js";
export async function getContentVersion(name) { return (await ContentVersion.findById(name).lean())?.version || 0; }
export async function bumpContentVersion(name) {
  await ContentVersion.findOneAndUpdate({ _id: name }, { $inc: { version: 1 } }, { upsert: true });
  if (name === "categories") await Promise.all([delCache("categories:active"), delCachePattern("categories:top:*")]);
  if (name === "onboarding") await delCache("onboarding:screens");
}
