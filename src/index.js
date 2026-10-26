import "dotenv/config";
import app from "./app.js";
import mongoose from "mongoose";
import redis from "./config/redis.js";
import { connectDB } from "./config/db.js";
import { logger } from "./utils/logger.js";
import { validateEnvironment } from "./config/environment.js";
validateEnvironment();
await connectDB();
const server = app.listen(process.env.PORT || 5000, () => logger.info("API listening"));
server.requestTimeout = 600000;
async function shutdown() {
  const timer = setTimeout(() => process.exit(1), 15000);
  server.close(async () => {
    await mongoose.disconnect();
    redis?.disconnect();
    clearTimeout(timer);
    process.exit(0);
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
export default app;
