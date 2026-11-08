import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import mongoose from "mongoose";
import { openStaging } from "./safety.js";
import { processSnapshot, assertProductionUnchanged } from "./rollout-safety.js";

const processes = () => JSON.parse(execFileSync("pm2", ["jlist"], { encoding: "utf8", timeout: 15000 }));
try {
  await openStaging();
  const before = processSnapshot(processes(), "new");
  if (await mongoose.connection.db.collection("videos").countDocuments({ processingStatus: { $in: ["uploaded", "queued", "processing"] } })) throw new Error("TEST_VIDEO_JOBS_STILL_RUNNING");
  const api = before.find(item => item.name === "talkmart-api-test");
  fs.mkdirSync("tmp", { recursive: true, mode: 0o700 });
  const log = fs.openSync("tmp/worker-restart.log", "a", 0o600), started = new Date();
  try { execFileSync("pm2", ["restart", "talkmart-worker-test"], { timeout: 330000, stdio: ["ignore", log, log] }); }
  finally { fs.closeSync(log); }
  const end = Date.now() + 120000;
  let after, ready = false;
  while (Date.now() < end) {
    const current = processes();
    assertProductionUnchanged(before, current);
    const currentApi = current.find(item => item.name === "talkmart-api-test");
    if (currentApi?.pid !== api.pid || currentApi.pm2_env?.pm_uptime !== api.uptime) throw new Error("TEST_API_RESTARTED_UNEXPECTEDLY");
    const worker = current.find(item => item.name === "talkmart-worker-test");
    if (worker?.pm2_env?.status === "online" && await mongoose.connection.db.collection("workerstatuses").findOne({
      _id: new RegExp("^" + worker.pid + "-"), heartbeatAt: { $gte: started },
    })) { after = processSnapshot(current, "new"); ready = true; break; }
    await delay(1000);
  }
  if (!ready) throw new Error("NEW_TEST_WORKER_HEARTBEAT_MISSING");
  const health = await fetch("https://api.talkmart.az/test-api/health", { signal: AbortSignal.timeout(15000) });
  if (health.status !== 200 || (await health.json()).status !== "ok") throw new Error("TEST_HEALTH_FAILED");
  fs.writeFileSync("tmp/last-worker-restart.json", JSON.stringify({ startedAt: started, verifiedAt: new Date(),
    repoCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), before, after }, null, 2) + "\n", { mode: 0o600 });
  console.log("Yeni kodla test worker və heartbeat: OK");
  console.log("Test API və canlı API/worker PID-ləri saxlanıldı: OK");
  console.log("Yeni upload ilə sürət ölçməsi üçün hazırdır.");
} catch (error) {
  console.error("Worker yeniləməsi:", /^[A-Z_]+$/.test(error.message || "") ? error.message : error.code || error.name);
  process.exitCode = 1;
} finally { await mongoose.disconnect(); }
