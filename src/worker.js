import "dotenv/config";
import crypto from "node:crypto";
import mongoose from "mongoose";
import redis from "./config/redis.js";
import { connectDB } from "./config/db.js";
import { validateEnvironment } from "./config/environment.js";
import { acquireLease, processVideoJob } from "./services/videoProcessing.service.js";
import { runMaintenance, reconcileOrphanObjects, cleanupTempFiles } from "./services/maintenance.service.js";
import { deliverNextReportNotification } from "./services/reportNotification.service.js";
import WorkerStatus from "./models/WorkerStatus.js";
import Video from "./models/Video.js";
import { getMetrics } from "./utils/metrics.js";
import { logger } from "./utils/logger.js";

validateEnvironment();
await connectDB();
if (await Video.exists({ schemaVersion: { $ne: 2 } })) {
  logger.error("Video migration is required before starting the worker");
  await mongoose.disconnect();
  redis?.disconnect();
  process.exit(1);
}
const id = `${process.pid}-${crypto.randomUUID()}`;
const concurrency = Number(process.env.VIDEO_WORKER_CONCURRENCY || 1);
const running = new Set();
let stopping = false;
let maintenanceAt = 0;
let orphanAt = 0;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });
logger.info("worker_started", { id, concurrency });
while (!stopping) {
  try {
    while (!stopping && running.size < concurrency) {
      const job = await acquireLease();
      if (!job) break;
      const task = processVideoJob(job).catch((err) => logger.error("worker_job_error", err)).finally(() => running.delete(task));
      running.add(task);
    }
    await deliverNextReportNotification();
    if (Date.now() - maintenanceAt > 30000) {
      maintenanceAt = Date.now();
      await runMaintenance();
      const snapshot = { running: running.size, latency: getMetrics(), memory: process.memoryUsage(), heartbeatAt: new Date() };
      await WorkerStatus.updateOne({ _id: id }, { $set: snapshot }, { upsert: true });
      logger.info("worker_metrics", snapshot);
    }
    if (Date.now() - orphanAt > 3600000) {
      orphanAt = Date.now();
      await reconcileOrphanObjects();
      await cleanupTempFiles();
    }
  } catch (err) { logger.error("worker_iteration_failed", err); }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
await Promise.allSettled(running);
await mongoose.disconnect();
redis?.disconnect();
