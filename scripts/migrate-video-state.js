import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import mongoose from "mongoose";
import Video from "../src/models/Video.js";
import User from "../src/models/User.js";
import Category from "../src/models/Category.js";
import AuditEvent from "../src/models/AuditEvent.js";
import { videoV2Fields } from "../src/services/videoMigration.service.js";
import { logger } from "../src/utils/logger.js";
const { EJSON } = mongoose.mongo.BSON;
const apply = process.argv.includes("--apply");
const rollbackAt = process.argv.indexOf("--rollback");
const migrationAt = new Date();
let changed = 0;
let conflicts = 0;
let snapshot;
const proposed = { processingStatus: {}, moderationStatus: {}, status: {} };
await mongoose.connect(process.env.MONGO_URI, { autoCreate: false, autoIndex: false });
try {
  if (rollbackAt !== -1) {
    const filename = process.argv[rollbackAt + 1];
    if (!filename) throw new Error("Pass a migration snapshot after --rollback");
    for await (const line of readline.createInterface({ input: fs.createReadStream(filename), crlfDelay: Infinity })) {
      const entry = EJSON.parse(line);
      if (apply) {
        const result = await Video.collection.updateOne({ _id: entry.id, migrationAt: entry.migrationAt, updatedAt: entry.guardUpdatedAt ?? { $exists: false } }, {
          $set: entry.previous, $unset: Object.fromEntries(entry.missing.map((key) => [key, ""])),
        });
        if (!result.matchedCount) conflicts++;
      }
      changed++;
    }
  } else {
    if (apply) {
      fs.mkdirSync("tmp/migrations", { recursive: true });
      snapshot = path.resolve("tmp/migrations", `video-v2-${Date.now()}.jsonl`);
    }
    for await (const video of Video.collection.find({ schemaVersion: { $ne: 2 } })) {
      const owner = await User.findById(video.providerId).lean();
      const fields = videoV2Fields(video, owner);
      const category = await Category.findById(video.categoryId).lean();
      fields.categoryName = category?.name || fields.categoryName;
      fields.migrationAt = migrationAt;
      for (const key of Object.keys(proposed)) {
        const value = fields[key];
        proposed[key][value] = (proposed[key][value] || 0) + 1;
      }
      if (apply) {
        const previous = Object.fromEntries(Object.keys(fields).filter((key) => video[key] !== undefined).map((key) => [key, video[key]]));
        const missing = Object.keys(fields).filter((key) => video[key] === undefined);
        fs.appendFileSync(snapshot, EJSON.stringify({ id: video._id, previous, missing, migrationAt, guardUpdatedAt: video.updatedAt }) + "\n", { mode: 0o600 });
        const result = await Video.collection.updateOne({ _id: video._id, schemaVersion: { $ne: 2 }, updatedAt: video.updatedAt ?? { $exists: false } }, { $set: fields });
        if (!result.matchedCount) conflicts++;
      }
      changed++;
    }
    if (apply) {
      await User.updateMany({ accountStatus: { $exists: false } }, { $set: { accountStatus: "active" } });
      await User.updateMany({ sessionVersion: { $exists: false } }, { $set: { sessionVersion: 1 } });
      await Video.createIndexes();
      await User.createIndexes();
    }
  }
  if (apply) await AuditEvent.create({ action: rollbackAt !== -1 ? "migration_video_v2_rollback" : "migration_video_v2", reason: `Changed ${changed}; conflicts ${conflicts}` });
  logger.info({ mode: apply ? "apply" : "dry-run", changed, conflicts, ...(rollbackAt === -1 ? { proposed } : {}), snapshot });
  if (conflicts) process.exitCode = 1;
} finally { await mongoose.disconnect(); }
