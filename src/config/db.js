import { logger } from "../utils/logger.js";
import mongoose from "mongoose";

export async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    const topology = await mongoose.connection.db.admin().command({ hello: 1 });
    if (!topology.setName && topology.msg !== "isdbgrid") throw new Error("MongoDB replica set or sharded cluster is required for transactions");
    logger.log("✅ MongoDB connected");
  } catch (err) {
    logger.error("❌ MongoDB connection error:", err.message);
    process.exit(1);
  }
}
