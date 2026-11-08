import mongoose from "mongoose";
import { openStaging } from "./safety.js";
import { logger } from "../../src/utils/logger.js";
let server;
try {
  await openStaging();
  const { default: swagger } = await import("../../src/swagger.js"); swagger.servers = [{ url: "/test-api/api" }];
  const { default: app } = await import("../../src/app.js");
  await Promise.all(Object.values(mongoose.models).map(model => model.createIndexes()));
  server = app.listen(5001, "127.0.0.1");
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  server.requestTimeout = 600000;
  logger.info("Performance staging API is ready");
} catch (error) { logger.error("Staging startup failed", error); await mongoose.disconnect(); process.exit(1); }
let stopping = false;
function shutdown() {
  if (stopping) return; stopping = true;
  const timer = setTimeout(() => process.exit(1), 14000);
  server.close(async () => { await mongoose.disconnect(); clearTimeout(timer); process.exit(0); });
}
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
