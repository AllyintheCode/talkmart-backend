import mongoose from "mongoose";
import { openStaging } from "./safety.js";
import { logger } from "../../src/utils/logger.js";
try { await openStaging(); await import("../../src/worker.js"); }
catch (error) { logger.error("Staging worker startup failed", error); await mongoose.disconnect(); process.exit(1); }
