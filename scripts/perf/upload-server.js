import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import mongoose from "mongoose";
import { assertIsolatedServices, assertLocalDatabase } from "./common.js";
import { createUploadStorage } from "./upload-storage.js";

assertIsolatedServices(process.env);
if (!process.send) throw new Error("PERF_UPLOAD_IPC_REQUIRED");
const directory = await fs.realpath(process.env.PERF_REPORT_DIRECTORY);
if (await fs.realpath(os.tmpdir()) !== path.join(directory, "api-temp")) throw new Error("PERF_UPLOAD_TEMP_NOT_OWNED");
const storage = await createUploadStorage(directory);
const name = assertLocalDatabase(process.env.MONGO_URI, process.env.PERF_RUN_ID);
mongoose.set("autoCreate", false); mongoose.set("autoIndex", false);
await mongoose.connect(process.env.MONGO_URI, { autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 10000 });
const marker = await mongoose.connection.db.collection("_perf_runs").findOne({ _id: process.env.PERF_RUN_ID, owned: true });
if (mongoose.connection.name !== name || !marker || marker.providers?.length !== 25) throw new Error("PERF_UPLOAD_DATABASE_NOT_OWNED");
const { default: r2 } = await import("../../src/config/r2.js");
r2.send = storage.send;
globalThis.fetch = async () => { throw new Error("PERF_UPLOAD_EXTERNAL_FETCH_BLOCKED"); };
const { default: app } = await import("../../src/app.js");
const { default: redis } = await import("../../src/config/redis.js");
const { signAccessToken } = await import("../../src/utils/jwt.js");
for (const filename of (await fs.readdir("src/models")).filter(filename => filename.endsWith(".js"))) await import("../../src/models/" + filename);
for (const model of Object.values(mongoose.models)) await model.createIndexes();
const loop = monitorEventLoopDelay({ resolution: 20 }); loop.enable();
let peak, started, cpu;
const reset = () => { peak = process.memoryUsage().rss; started = performance.now(); cpu = process.cpuUsage(); loop.reset(); storage.reset(); };
reset();
const sample = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 50); sample.unref();
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/_perf/")) {
    if (req.headers["x-perf-run"] !== process.env.PERF_RUN_ID) { res.writeHead(403).end(); return; }
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/_perf/reset" && req.method === "POST") { reset(); res.end('{"ok":true}'); return; }
    if (req.url === "/_perf/stats") {
      const usage = process.cpuUsage(cpu);
      res.end(JSON.stringify({ apiPeakRssBytes: Math.max(peak, process.memoryUsage().rss), cpuUserMs: usage.user / 1000,
        cpuSystemMs: usage.system / 1000, elapsedMs: performance.now() - started,
        eventLoopP95Ms: loop.percentile(95) / 1e6, storage: storage.stats() })); return;
    }
    res.writeHead(404).end(); return;
  }
  app(req, res);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
process.send({ type: "ready", runId: process.env.PERF_RUN_ID, origin: `http://127.0.0.1:${server.address().port}`,
  tokens: marker.providers.map(id => signAccessToken({ id: String(id), sv: 1 })) });
let stopping = false;
function stop() {
  if (stopping) return; stopping = true;
  const timer = setTimeout(() => process.exit(1), 5000);
  server.close(async () => { clearInterval(sample); loop.disable(); r2.destroy(); redis?.disconnect(); await mongoose.disconnect(); clearTimeout(timer); process.exit(0); });
  server.closeAllConnections();
}
process.on("message", message => { if (message?.type === "stop") stop(); });
process.on("disconnect", stop); process.on("SIGTERM", stop); process.on("SIGINT", stop);
