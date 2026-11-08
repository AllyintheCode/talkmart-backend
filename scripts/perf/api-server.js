import fs from "node:fs";
import http from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import mongoose from "mongoose";
import { assertIsolatedServices, assertLocalDatabase, summary } from "./common.js";

assertIsolatedServices(process.env);
const databaseName = assertLocalDatabase(process.env.MONGO_URI, process.env.PERF_RUN_ID);
mongoose.set("autoCreate", false);
mongoose.set("autoIndex", false);
await mongoose.connect(process.env.MONGO_URI, { autoCreate: false, autoIndex: false, monitorCommands: true, serverSelectionTimeoutMS: 10000 });
if (mongoose.connection.name !== databaseName || !await mongoose.connection.db.collection("_perf_runs").findOne({ _id: process.env.PERF_RUN_ID, owned: true })) {
  await mongoose.disconnect();
  throw new Error("PERF_DATABASE_MARKER_MISSING");
}
const { default: app } = await import("../../src/app.js");
const { default: redis } = await import("../../src/config/redis.js");
const { signAccessToken } = await import("../../src/utils/jwt.js");
for (const filename of fs.readdirSync("src/models").filter(name => name.endsWith(".js"))) await import("../../src/models/" + filename);
for (const model of Object.values(mongoose.models)) await model.createIndexes();

const context = new AsyncLocalStorage();
const commands = new Set(["find", "aggregate", "findAndModify", "getMore", "count", "insert", "update", "delete"]);
let records, pipelines, countPipelines, peakRss, cpuStart, started;
const delay = monitorEventLoopDelay({ resolution: 20 });
delay.enable();
function reset() {
  records = []; pipelines = new Map(); countPipelines = new Map(); peakRss = process.memoryUsage().rss;
  cpuStart = process.cpuUsage(); started = performance.now(); delay.reset();
}
reset();
const sampling = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 100);
sampling.unref();
mongoose.connection.getClient().on("commandStarted", event => {
  const current = context.getStore();
  if (!current || !commands.has(event.commandName)) return;
  current.commands[event.commandName] = (current.commands[event.commandName] || 0) + 1;
  if (event.commandName === "aggregate" && event.command.aggregate === "videos") {
    const target = event.command.pipeline.some(stage => stage.$group) ? countPipelines : pipelines;
    if (!target.has(current.name)) target.set(current.name,
      mongoose.mongo.BSON.EJSON.parse(mongoose.mongo.BSON.EJSON.stringify(event.command.pipeline, { relaxed: false })));
  }
});

function status() {
  const cpu = process.cpuUsage(cpuStart), elapsedMs = performance.now() - started;
  const totals = {};
  for (const record of records) for (const [key, count] of Object.entries(record.commands)) totals[key] = (totals[key] || 0) + count;
  return {
    requestsObserved: records.length, dbCommandsByType: totals,
    dbCommandsPerRequest: summary(records.map(record => Object.values(record.commands).reduce((sum, value) => sum + value, 0))),
    apiPeakRssBytes: Math.max(peakRss, process.memoryUsage().rss),
    apiCpuUserMs: cpu.user / 1000, apiCpuSystemMs: cpu.system / 1000,
    apiCpuPercentOfOneCore: (cpu.user + cpu.system) / 1000 / elapsedMs * 100,
    eventLoopDelayMs: { p50: delay.percentile(50) / 1e6, p95: delay.percentile(95) / 1e6, p99: delay.percentile(99) / 1e6 },
    capturedPipelineCases: [...pipelines.keys()],
    countPipelineCases: [...countPipelines.keys()],
  };
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname.startsWith("/_perf/")) {
    if (req.headers["x-perf-run"] !== process.env.PERF_RUN_ID) { res.writeHead(403).end(); return; }
    const send = value => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value)); };
    if (url.pathname === "/_perf/reset" && req.method === "POST") { reset(); send({ ok: true }); return; }
    if (url.pathname === "/_perf/stats") { send(status()); return; }
    if (url.pathname === "/_perf/explain") {
      const pipeline = (url.searchParams.get("phase") === "provider-counts" ? countPipelines : pipelines).get(url.searchParams.get("case"));
      if (!pipeline) { res.writeHead(404); send({ error: "PIPELINE_NOT_CAPTURED" }); return; }
      mongoose.connection.db.command({ explain: { aggregate: "videos", pipeline, cursor: {}, maxTimeMS: 10000 }, verbosity: "executionStats" })
        .then(send).catch(error => { res.writeHead(500); send({ error: error.codeName || error.name }); });
      return;
    }
    res.writeHead(404).end(); return;
  }
  const name = req.headers["x-perf-case"];
  if (typeof name !== "string" || !/^[a-z0-9_-]{1,60}$/.test(name)) { app(req, res); return; }
  const record = { name, commands: {} };
  res.once("finish", () => records.push(record));
  context.run(record, () => app(req, res));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
process.send?.({ type: "ready", origin: `http://127.0.0.1:${server.address().port}`,
  runId: process.env.PERF_RUN_ID, token: signAccessToken({ id: process.env.PERF_USER_ID, sv: 1 }) });
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  const timeout = setTimeout(() => process.exit(1), 5000);
  server.close(async () => {
    clearInterval(sampling); delay.disable(); await mongoose.disconnect(); redis?.disconnect();
    clearTimeout(timeout); process.exit(0);
  });
  server.closeAllConnections();
}
process.on("message", message => { if (message?.type === "stop") shutdown(); });
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("disconnect", shutdown);
