import fs from "node:fs";
import path from "node:path";
import { parse } from "dotenv";
import mongoose from "mongoose";

export const releaseDirectory = "/var/www/backend-perf-test-20261108";
export function assertStagingSettings(env, live) {
  for (const [key, value] of Object.entries({ NODE_ENV: "production", PORT: "5001", R2_BUCKET: "talkmart-test-media",
    R2_STAGING_BUCKET: "talkmart-test-staging", R2_PUBLIC_URL: "https://pub-4cc7f7a623fc4b02852a0e4f3c5502e4.r2.dev",
    REDIS_DISABLED: "true", VIDEO_WORKER_CONCURRENCY: "1" })) {
    if (env[key] !== value) throw new Error("UNEXPECTED_STAGING_" + key);
  }
  if (!env.MONGO_URI || env.MONGO_URI === live.MONGO_URI) throw new Error("STAGING_DATABASE_NOT_SEPARATE");
  const liveKeys = new Set([live.JWT_SECRET, live.JWT_ACCESS_SECRET, live.JWT_RESET_SECRET].filter(Boolean));
  for (const key of [env.JWT_SECRET, env.JWT_ACCESS_SECRET || env.JWT_SECRET, env.JWT_RESET_SECRET || env.JWT_SECRET]) {
    if (typeof key !== "string" || key.length < 32 || liveKeys.has(key)) throw new Error("STAGING_JWT_NOT_SEPARATE");
  }
  if (!env.OTP_PEPPER || env.OTP_PEPPER.length < 32 || env.OTP_PEPPER === live.OTP_PEPPER) throw new Error("STAGING_OTP_NOT_SEPARATE");
}
export function privateExpirationIsSafe(rules = []) {
  return rules.every(rule => {
    if (rule.Status !== "Enabled" || !rule.Expiration) return true;
    const prefix = rule.Filter?.And?.Prefix ?? rule.Filter?.Prefix ?? rule.Prefix ?? "";
    return !("talkmart/private/".startsWith(prefix) || prefix.startsWith("talkmart/private/"));
  });
}
export async function checkPrivateLifecycle(readRules, { dashboardConfirmed = false } = {}) {
  let rules;
  try { rules = await readRules(); }
  catch (error) {
    if (error.name === "NoSuchLifecycleConfiguration") rules = [];
    else if (error.name === "AccessDenied" || error.code === "AccessDenied") {
      return { verified: dashboardConfirmed, source: dashboardConfirmed ? "dashboard" : "pending" };
    } else throw error;
  }
  if (!privateExpirationIsSafe(rules)) throw new Error("PRIVATE_MEDIA_EXPIRATION_RULE_UNSAFE");
  return { verified: true, source: "api" };
}
export async function openStaging() {
  if (process.platform !== "linux" || fs.realpathSync(process.cwd()) !== releaseDirectory) throw new Error("STAGING_RELEASE_DIRECTORY_REQUIRED");
  const env = parse(fs.readFileSync("/var/www/backend-test/.env", "utf8"));
  const live = parse(fs.readFileSync("/var/www/backend-release-20261106/.env", "utf8"));
  assertStagingSettings(env, live);
  Object.assign(process.env, env, { TRUST_PROXY: "loopback", DOTENV_CONFIG_PATH: path.join(releaseDirectory, "unused.env") });
  const { validateEnvironment } = await import("../../src/config/environment.js"); validateEnvironment();
  await mongoose.connect(env.MONGO_URI, { autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 10000 });
  if (mongoose.connection.name !== "talkmart_staging") throw new Error("STAGING_DATABASE_NAME_MISMATCH");
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  if (!hello.setName && hello.msg !== "isdbgrid") throw new Error("STAGING_REPLICA_SET_REQUIRED");
  return mongoose;
}
