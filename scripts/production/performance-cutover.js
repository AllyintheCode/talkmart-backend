import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const LIVE = "/var/www/backend-release-20261106", CANDIDATE = "/var/www/backend-release-20261110";
const BASE = "94cc79d5d57365fcd41aeecb576587e49dcc19b3";
const MANIFEST_SHA256 = "__PACKAGE_MANIFEST_SHA256__";
const PREFLIGHT_REPORT = "__PACKAGE_PREFLIGHT_REPORT__";
const PANEL_CONFIRMATION = "__PACKAGE_PANEL_CONFIRMATION__";
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const fileHash = filename => digest(fs.readFileSync(filename));
const must = (condition, code) => { if (!condition) throw new Error(code); };

export function validateCutoverEvidence(report, spec, envHash, now = Date.now()) {
  must(spec && /^[a-f0-9]{40}$/.test(spec.releaseCommit || "") && /^[a-f0-9]{64}$/.test(spec.packageLockSha256 || "") && /^[a-f0-9]{64}$/.test(envHash || ""), "INVALID_CUTOVER_EVIDENCE_CONTEXT");
  const checks = ["privatePreviewAndRange", "copyPublicationAndOriginRevocation", "signedLengthRejected", "expiredPartRejected", "completedPartImmutable", "multipartMetadataAndHash", "ownedCanariesRemoved"];
  const age = now - new Date(report?.finishedAt).getTime();
  must(report?.kind === "talkmart-production-performance-preflight" && report.passed === true && report.prepared === true && report.candidateTestsPassed === true && report.applicationChanges === false &&
    report.allProcessIdsPreserved === true && report.databaseMetadataUnchanged === true && report.smtpVerified === true &&
    report.releaseCommit === spec.releaseCommit && report.baseCommit === BASE && report.envHash === envHash && report.packageLockSha256 === spec.packageLockSha256 &&
    report.database?.name === "test" && report.database?.unversionedVideos === 0 &&
    ["api_safe", "dashboard_required"].includes(report.storage?.privateLifecycle) && checks.every(name => report.storage?.checks?.[name] === true) &&
    Number.isFinite(age) && age >= -60000 && age <= 86400000, "FRESH_PASSED_PRODUCTION_PREFLIGHT_REQUIRED");
  return report;
}
export function cutoverModulePaths(id) {
  must(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id), "INVALID_PRODUCTION_CUTOVER_ID");
  return { current: LIVE + "/node_modules", before: LIVE + "/.talkmart-modules-before-" + id, next: LIVE + "/.talkmart-modules-next-" + id };
}
export function oldCodeRecoveryAllowed(state) {
  return state.newWorkerMayHaveStarted === false && state.apiMayHaveAdmitted === false && state.sessions === 0 &&
    state.trackedChanges === false && state.envUnchanged === true && /^[a-f0-9]{40}$/.test(state.releaseCommit || "") &&
    state.releaseCommit !== BASE && [BASE, state.releaseCommit].includes(state.currentCommit);
}
export function assertStagingUnchanged(before, processes) {
  const initial = before.filter(row => row.name.endsWith("-test")); must(initial.length === 2, "TWO_STAGING_PROCESSES_REQUIRED");
  for (const row of initial) {
    const matches = processes.filter(item => item.name === row.name), current = matches[0];
    must(matches.length === 1 && current.pid === row.pid && current.pm2_env?.pm_uptime === row.uptime && current.pm2_env?.status === "online" &&
      current.pm2_env.pm_cwd === row.cwd && current.pm2_env.pm_exec_path === row.script, "STAGING_PROCESS_CHANGED_DURING_PRODUCTION_CUTOVER");
  }
}
export function productionProcessArgs(action, name) {
  must(["talkmart-api", "talkmart-worker"].includes(name) && ["stop", "restart"].includes(action), "ONLY_PRODUCTION_STOP_RESTART_ALLOWED");
  return action === "stop" ? ["stop", name] : ["restart", name, "--update-env"];
}
export function sameProductionEnv(current, original) {
  const pairs = value => Object.entries(value).filter(([key]) => key !== "DIRECT_UPLOAD_ENABLED").sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(pairs(current)) === JSON.stringify(pairs(original));
}
export function cutoverEnvText(text, enabled, parse) {
  must(typeof text === "string" && typeof enabled === "boolean", "INVALID_PRODUCTION_ENV_FLAG");
  const next = text + (text.endsWith("\n") ? "" : "\n") + `DIRECT_UPLOAD_ENABLED=${enabled}\n`;
  const before = parse(text), after = parse(next);
  must(sameProductionEnv(before, after) && after.DIRECT_UPLOAD_ENABLED === String(enabled), "PRODUCTION_ENV_VALUES_CHANGED");
  return next;
}
export function assertEffectiveProductionConfig(processes, config) {
  const keys = ["MONGO_URI", "OTP_PEPPER", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_STAGING_BUCKET", "R2_PUBLIC_URL"];
  for (const name of ["talkmart-api", "talkmart-worker"]) {
    const rows = processes.filter(row => row.name === name); must(rows.length === 1, "PRODUCTION_CONFIG_PROCESS_COUNT_MISMATCH");
    const effective = { ...config }, pm = rows[0].pm2_env || {};
    for (const key of [...keys, "JWT_SECRET", "JWT_ACCESS_SECRET", "JWT_RESET_SECRET"]) {
      if (typeof pm[key] === "string") effective[key] = pm[key];
      else if (typeof pm.env?.[key] === "string") effective[key] = pm.env[key];
    }
    must(keys.every(key => effective[key] === config[key]) && effective.JWT_SECRET === config.JWT_SECRET &&
      (effective.JWT_ACCESS_SECRET || effective.JWT_SECRET) === (config.JWT_ACCESS_SECRET || config.JWT_SECRET) &&
      (effective.JWT_RESET_SECRET || effective.JWT_SECRET) === (config.JWT_RESET_SECRET || config.JWT_SECRET), "LIVE_EFFECTIVE_KEYS_DIFFER_FROM_ENV_FILE");
  }
}

async function applyCutover() {
  let mongoose, client, appRedis, appStorage, directory, journal, before, spec, envBefore, config, parse, modules, lockFd, savedToken;
  let paused = false, newWorkerMayHaveStarted = false, apiMayHaveAdmitted = false, oldModulesMoved = false, newModulesMoved = false;
  let cancelled = false, recovering = false, complete = false, phase = "scope";
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => { cancelled = true; });
  const ensure = () => { if (cancelled && !recovering) throw new Error("PRODUCTION_CUTOVER_INTERRUPTED"); };
  const read = (command, args, cwd = LIVE) => execFileSync(command, args, { cwd, encoding: "utf8", timeout: 15000 });
  const git = args => read("git", args).trim();
  const list = () => JSON.parse(read("pm2", ["jlist"]));
  const unchangedTests = () => {
    try { assertStagingUnchanged(before, list()); }
    catch (error) { if (!recovering) throw error; if (journal) journal.externalStagingChangeDuringRecovery = true; }
  };
  const canonicalLive = () => must(fs.realpathSync(LIVE) === LIVE && fs.realpathSync(LIVE + "/.env") === LIVE + "/.env", "LIVE_PATH_CHANGED");
  const persist = () => {
    if (!directory || !journal) return;
    Object.assign(journal, { phase, newWorkerMayHaveStarted, apiMayHaveAdmitted, oldModulesMoved, newModulesMoved, updatedAt: new Date().toISOString() });
    const temporary = path.join(directory, "manifest.next.json"); fs.writeFileSync(temporary, JSON.stringify(journal, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temporary, path.join(directory, "manifest.json"));
  };
  const stage = name => { ensure(); phase = name; persist(); };
  const command = (program, args, log, options = {}) => {
    ensure(); unchangedTests();
    const fd = fs.openSync(path.join(directory, log), "a", 0o600);
    try { execFileSync(program, args, { cwd: LIVE, timeout: 300000, stdio: ["ignore", fd, fd], ...options }); } finally { fs.closeSync(fd); }
  };
  const writeFlag = enabled => {
    canonicalLive(); const current = fs.readFileSync(LIVE + "/.env", "utf8");
    must(sameProductionEnv(parse(current), parse(envBefore.toString("utf8"))), "OPERATOR_CHANGED_PRODUCTION_ENV");
    const temporary = LIVE + "/.env.cutover-" + journal.id;
    fs.writeFileSync(temporary, cutoverEnvText(current, enabled, parse), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, LIVE + "/.env"); fs.chmodSync(LIVE + "/.env", 0o600);
  };
  const processAction = (action, name) => {
    const args = productionProcessArgs(action, name), rows = list().filter(row => row.name === name);
    must(rows.length === 1 && rows[0].pm2_env?.pm_cwd === LIVE && rows[0].pm2_env.pm_exec_path === LIVE + `/src/${name.includes("worker") ? "worker" : "index"}.js`, "PRODUCTION_PROCESS_PATH_CHANGED");
    canonicalLive();
    if (action === "restart") must([BASE, spec.releaseCommit].includes(git(["rev-parse", "HEAD"])) && !git(["status", "--porcelain", "--untracked-files=no"]) &&
      sameProductionEnv(parse(fs.readFileSync(LIVE + "/.env", "utf8")), parse(envBefore)), "OPERATOR_CHANGED_CODE_OR_ENV_BEFORE_RESTART");
    const system = Object.fromEntries(["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    command("pm2", args, "processes.log", { timeout: 330000, env: { ...system, ...parse(fs.readFileSync(LIVE + "/.env", "utf8")) } });
  };
  const idle = async () => {
    const db = mongoose.connection.db;
    const videos = await db.collection("videos").countDocuments({ $or: [
      { processingStatus: { $in: ["uploaded", "queued", "processing", "deleting"] } }, { status: "deleting" },
      { mediaPublicationId: { $ne: null } }, { mediaRevocationPending: true }, { "publicDeletionKeys.0": { $exists: true } },
    ] });
    const users = await db.collection("users").countDocuments({ $or: [{ accountStatus: "deleting" },
      { uploadReservation: { $type: "string", $ne: "" }, uploadReservedUntil: { $gt: new Date() } }] });
    return videos === 0 && users === 0 && await db.collection("uploadsessions").countDocuments() === 0;
  };
  const identity = async () => {
    const db = mongoose.connection.db, result = {};
    for (const name of ["users", "videos"]) result[name] = (await db.collection(name).find({}, { projection: { _id: 1 } }).sort({ _id: 1 }).toArray()).map(row => String(row._id));
    return result;
  };
  const health = async url => {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200); assert.equal((await response.json()).status, "ok");
  };
  const readyApi = async started => {
    const until = Date.now() + 60000;
    while (Date.now() < until) {
      ensure(); unchangedTests(); const api = list().find(row => row.name === "talkmart-api");
      try { must(api?.pm2_env?.status === "online" && api.pm2_env.pm_uptime >= started.getTime(), "NEW_PRODUCTION_API_REQUIRED"); await health("http://127.0.0.1:5000/health"); return; }
      catch { await delay(1000); }
    }
    throw new Error("NEW_PRODUCTION_API_NOT_READY");
  };
  const readyWorker = async started => {
    const until = Date.now() + 120000;
    while (Date.now() < until) {
      ensure(); unchangedTests(); const worker = list().find(row => row.name === "talkmart-worker");
      if (worker?.pm2_env?.status === "online" && worker.pm2_env.pm_uptime >= started.getTime() &&
        await mongoose.connection.db.collection("workerstatuses").findOne({ _id: new RegExp("^" + worker.pid + "-"), heartbeatAt: { $gte: started } })) return;
      await delay(1000);
    }
    throw new Error("NEW_PRODUCTION_WORKER_HEARTBEAT_MISSING");
  };
  try {
    must(process.platform === "linux" && fs.realpathSync(fileURLToPath(import.meta.url)) === "/root/talkmart-performance-cutover.mjs" &&
      /^[a-f0-9]{64}$/.test(MANIFEST_SHA256) && /^\/root\/talkmart-deployments\/performance-preflight-20261110-[a-zA-Z0-9]+\/preflight\.json$/.test(PREFLIGHT_REPORT) &&
      PANEL_CONFIRMATION === "confirmed-by-user-2026-11-10", "PACKAGED_CONFIRMED_PRODUCTION_CUTOVER_REQUIRED");
    lockFd = fs.openSync("/root/talkmart-performance-preflight.lock", fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
    must(fs.fstatSync(lockFd).isFile(), "INVALID_PRODUCTION_LOCK");
    try { execFileSync("flock", ["-n", "3"], { stdio: ["ignore", "ignore", "ignore", lockFd] }); } catch { throw new Error("ANOTHER_PRODUCTION_OPERATION_IS_RUNNING"); }
    canonicalLive(); must(fs.realpathSync(CANDIDATE) === CANDIDATE, "CANDIDATE_PATH_CHANGED");
    must(fileHash("/root/talkmart-performance-live.json") === MANIFEST_SHA256, "PRODUCTION_MANIFEST_CHANGED");
    spec = JSON.parse(fs.readFileSync("/root/talkmart-performance-live.json", "utf8"));
    must(fileHash("/root/talkmart-performance-live.bundle") === spec.bundleSha256 && git(["rev-parse", "HEAD"]) === BASE && !git(["status", "--porcelain", "--untracked-files=no"]), "LIVE_CODE_OR_PACKAGE_CHANGED");
    must(read("git", ["rev-parse", "HEAD"], CANDIDATE).trim() === spec.releaseCommit && !read("git", ["status", "--porcelain", "--untracked-files=no"], CANDIDATE).trim() &&
      digest(execFileSync("git", ["show", "HEAD:package-lock.json"], { cwd: CANDIDATE })) === spec.packageLockSha256 && !fs.existsSync(CANDIDATE + "/.env"), "CANDIDATE_NO_LONGER_UNUSED_OR_VERIFIED");
    const safety = await import(pathToFileURL(CANDIDATE + "/scripts/production/performance-preflight.js"));
    safety.validatePerformanceManifest(spec);
    before = safety.deploymentProcesses(list());
    must(!list().some(row => row.pm2_env?.pm_cwd === CANDIDATE), "CANDIDATE_PROCESS_EXISTS");
    const require = createRequire(CANDIDATE + "/package.json"); ({ parse } = require("dotenv"));
    envBefore = fs.readFileSync(LIVE + "/.env"); const env = parse(envBefore), stageEnv = parse(fs.readFileSync("/var/www/backend-test/.env", "utf8"));
    safety.validateProductionSettings(env, stageEnv);
    assertEffectiveProductionConfig(list(), env);
    must(fs.realpathSync(PREFLIGHT_REPORT) === PREFLIGHT_REPORT, "PREFLIGHT_REPORT_PATH_CHANGED");
    validateCutoverEvidence(JSON.parse(fs.readFileSync(PREFLIGHT_REPORT, "utf8")), spec, digest(envBefore));
    mongoose = require("mongoose"); await mongoose.connect(env.MONGO_URI, { autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 10000 });
    must(mongoose.connection.name === "test", "PRODUCTION_DATABASE_MISMATCH");
    const hello = await mongoose.connection.db.admin().command({ hello: 1 }); must(hello.setName || hello.msg === "isdbgrid", "PRODUCTION_REPLICA_SET_REQUIRED");
    must(await mongoose.connection.db.collection("videos").countDocuments({ schemaVersion: { $ne: 2 } }) === 0 && await idle(), "LIVE_QUEUE_RESERVATION_OR_CLEANUP_PENDING");
    const provider = await mongoose.connection.db.collection("users").findOne({ role: "provider", emailVerified: true, isBlocked: false, accountStatus: { $ne: "deleting" }, "providerProfile.verified": true });
    must(Boolean(provider), "NO_VERIFIED_PROVIDER_FOR_AUTH_PROBE");
    Object.assign(process.env, env, { DOTENV_CONFIG_PATH: CANDIDATE + "/tmp/nonexistent-production-cutover.env" });
    const { signAccessToken } = await import(pathToFileURL(CANDIDATE + "/src/utils/jwt.js"));
    savedToken = signAccessToken({ id: String(provider._id), sv: provider.sessionVersion ?? 1 });
    const oldAuth = await fetch("http://127.0.0.1:5000/api/videos/my-videos?limit=1", { headers: { Authorization: "Bearer " + savedToken }, signal: AbortSignal.timeout(15000) });
    must(oldAuth.status === 200 && (await oldAuth.json()).success === true, "CURRENT_LIVE_SIGNING_CONFIGURATION_MISMATCH");
    await health("https://api.talkmart.az/health"); await health("https://api.talkmart.az/test-api/health");
    for (const program of ["mongodump", "mongorestore"]) execFileSync(program, ["--version"], { stdio: "pipe", timeout: 15000 });
    execFileSync("nginx", ["-t"], { stdio: "pipe", timeout: 15000 });
    fs.mkdirSync("/root/talkmart-backups", { recursive: true, mode: 0o700 });
    for (const root of [LIVE, "/root/talkmart-backups"]) { const stat = fs.statfsSync(root); must(stat.bavail * stat.bsize > 512 * 1024 * 1024, "NOT_ENOUGH_FREE_DISK_FOR_CUTOVER"); }
    directory = fs.mkdtempSync("/root/talkmart-backups/performance-live-20261110-"); fs.chmodSync(directory, 0o700);
    journal = { kind: "talkmart-production-performance-cutover", id: crypto.randomUUID(), startedAt: new Date().toISOString(), baseCommit: BASE, releaseCommit: spec.releaseCommit,
      database: "test", envHash: digest(envBefore), preflightReport: PREFLIGHT_REPORT, preflightHash: fileHash(PREFLIGHT_REPORT), processesBefore: before, files: {}, objects: [],
      privatePanel: { bucket: "talkmart-staging", developmentUrlDisabled: true, noCustomDomains: true, lifecycle: "abort_incomplete_after_7_days", confirmedByUser: "2026-11-10" }, backupComplete: false };
    modules = cutoverModulePaths(journal.id); journal.modulePaths = modules; persist();
    stage("prepare_dependencies");
    must(fs.realpathSync(modules.current) === modules.current && fs.realpathSync(CANDIDATE + "/node_modules") === CANDIDATE + "/node_modules" && !fs.existsSync(modules.next) && !fs.existsSync(modules.before), "UNEXPECTED_MODULE_DIRECTORY");
    command("cp", ["-a", "--", CANDIDATE + "/node_modules", modules.next], "dependency-copy.log");
    fs.chmodSync(modules.next, 0o700);
    must(digest(fs.readFileSync(LIVE + "/.env")) === journal.envHash && await idle(), "LIVE_CHANGED_BEFORE_PAUSE");
    stage("pause_and_drain_production"); paused = true; processAction("stop", "talkmart-api");
    const drainDeadline = Date.now() + 120000;
    while (!await idle() && Date.now() < drainDeadline) { ensure(); unchangedTests(); await delay(1000); }
    must(await idle(), "LIVE_WORK_DID_NOT_DRAIN"); processAction("stop", "talkmart-worker"); must(await idle(), "LIVE_QUEUE_CHANGED_WHILE_STOPPING");
    console.log("Yalniz canli API/worker idareli dayandirildi; test prosesleri saxlanildi: OK");
    stage("fresh_backup");
    journal.identitiesBefore = await identity();
    config = path.join(directory, ".mongo-config.yml"); fs.writeFileSync(config, `uri: ${JSON.stringify(env.MONGO_URI)}\n`, { mode: 0o600, flag: "wx" });
    fs.writeFileSync(path.join(directory, "settings.env"), envBefore, { mode: 0o600 });
    fs.writeFileSync(path.join(directory, "pm2-before.json"), JSON.stringify(list()), { mode: 0o600 });
    command("tar", ["--exclude=./node_modules", "--exclude=./.git", "--exclude=./.talkmart-modules-*", "--exclude=./tmp/performance", "-czf", path.join(directory, "code.tar.gz"), "-C", LIVE, "."], "backup.log");
    command("git", ["bundle", "create", path.join(directory, "code.bundle"), "--all"], "backup.log");
    command("mongodump", ["--config=" + config, "--db=test", "--archive=" + path.join(directory, "mongodb-test.archive.gz"), "--gzip"], "mongodump.log");
    command("gzip", ["-t", path.join(directory, "code.tar.gz"), path.join(directory, "mongodb-test.archive.gz")], "backup-check.log");
    command("mongorestore", ["--config=" + config, "--archive=" + path.join(directory, "mongodb-test.archive.gz"), "--gzip", "--nsInclude=test.*", "--dryRun"], "restore-preview.log");
    fs.writeFileSync(path.join(directory, "nginx-before.txt"), execFileSync("nginx", ["-T"], { stdio: ["ignore", "pipe", "pipe"], timeout: 15000 }), { mode: 0o600 });
    for (const name of ["settings.env", "pm2-before.json", "code.tar.gz", "code.bundle", "mongodb-test.archive.gz", "nginx-before.txt"]) { fs.chmodSync(path.join(directory, name), 0o600); journal.files[name] = fileHash(path.join(directory, name)); }
    const sdk = require("@aws-sdk/client-s3"); client = new sdk.S3Client({ region: "auto", endpoint: env.R2_ENDPOINT, requestChecksumCalculation: "WHEN_REQUIRED", maxAttempts: 1,
      credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY } });
    const send = value => client.send(value, { abortSignal: AbortSignal.timeout(120000) });
    const videos = await mongoose.connection.db.collection("videos").find().limit(10001).toArray(), users = await mongoose.connection.db.collection("users").find().limit(10001).toArray();
    must(videos.length <= 10000 && users.length <= 10000, "BACKUP_INVENTORY_REQUIRES_LARGER_PLAN");
    const { mediaInventory } = await import(pathToFileURL(CANDIDATE + "/scripts/staging/rollout-safety.js"));
    const required = new Set(mediaInventory(videos.map(video => ({ ...video, mediaKeys: [], publicDeletionKeys: [] })), users, env.R2_PUBLIC_URL));
    stage("private_media_backup");
    for (const key of mediaInventory(videos, users, env.R2_PUBLIC_URL)) {
      ensure(); unchangedTests(); const bucket = key.startsWith("talkmart/private/") || key.startsWith("talkmart/staging/") ? "talkmart-staging" : "talkmart";
      const backupKey = `talkmart/private/rollout-backups/${journal.id}/${bucket}/${key}`; let head;
      try { head = await send(new sdk.HeadObjectCommand({ Bucket: bucket, Key: key })); }
      catch (error) { if (["NotFound", "NoSuchKey"].includes(error.name) || error.$metadata?.httpStatusCode === 404) { must(!required.has(key), "REFERENCED_MEDIA_MISSING_BEFORE_RELEASE"); journal.objects.push({ bucket, key, backupKey, missing: true }); persist(); continue; } throw error; }
      await send(new sdk.CopyObjectCommand({ Bucket: "talkmart-staging", Key: backupKey, CopySource: [bucket, ...key.split("/")].map(encodeURIComponent).join("/"), CopySourceIfMatch: head.ETag,
        MetadataDirective: "REPLACE", ContentType: head.ContentType || "application/octet-stream", CacheControl: "private, no-store" }));
      const copied = await send(new sdk.HeadObjectCommand({ Bucket: "talkmart-staging", Key: backupKey })); must(copied.ContentLength === head.ContentLength, "MEDIA_BACKUP_SIZE_MISMATCH");
      journal.objects.push({ bucket, key, backupKey, bytes: head.ContentLength, etag: head.ETag, contentType: head.ContentType, cacheControl: head.CacheControl, metadata: head.Metadata || {} }); persist();
    }
    journal.backupComplete = true; persist(); console.log("Teze kod/env/PM2/nginx/MongoDB ve private media backup-i: OK"); console.log("Ehtiyat nusxe:", directory);
    stage("fast_forward_code"); canonicalLive();
    must(git(["rev-parse", "HEAD"]) === BASE && !git(["status", "--porcelain", "--untracked-files=no"]) && fileHash(LIVE + "/.env") === journal.envHash && await idle(), "LIVE_CHANGED_DURING_BACKUP");
    command("git", ["fetch", "/root/talkmart-performance-live.bundle", "refs/heads/codex/performance-baseline"], "code-update.log");
    must(git(["rev-parse", "FETCH_HEAD"]) === spec.releaseCommit, "RELEASE_REF_CHANGED"); command("git", ["merge", "--ff-only", "FETCH_HEAD"], "code-update.log");
    must(git(["rev-parse", "HEAD:src"]) === spec.runtimeSrcTree && digest(execFileSync("git", ["show", "HEAD:package-lock.json"], { cwd: LIVE })) === spec.packageLockSha256, "RELEASE_CONTENT_MISMATCH");
    stage("swap_verified_dependencies"); canonicalLive();
    fs.renameSync(modules.current, modules.before); oldModulesMoved = true; persist();
    fs.renameSync(modules.next, modules.current); newModulesMoved = true; persist(); writeFlag(false);
    stage("initialize_indexes");
    Object.assign(process.env, parse(fs.readFileSync(LIVE + "/.env", "utf8")));
    await import(pathToFileURL(CANDIDATE + "/src/app.js"));
    appRedis = (await import(pathToFileURL(CANDIDATE + "/src/config/redis.js"))).default;
    appStorage = await import(pathToFileURL(CANDIDATE + "/src/config/r2.js"));
    await Promise.all(Object.values(mongoose.models).map(model => model.createIndexes()));
    assert.deepEqual(await identity(), journal.identitiesBefore); must(await idle(), "LIVE_CHANGED_BEFORE_NEW_WORKER");
    console.log("Yeni kod, asılıliqlar, indeksler; movcud hesab/video ID-leri qorundu: OK");
    stage("start_new_worker"); newWorkerMayHaveStarted = true; persist();
    const workerStarted = new Date(); processAction("restart", "talkmart-worker"); await readyWorker(workerStarted);
    assert.deepEqual(await identity(), journal.identitiesBefore);
    stage("enable_direct_and_start_api"); writeFlag(true); apiMayHaveAdmitted = true; persist();
    const apiStarted = new Date(); processAction("restart", "talkmart-api"); await readyApi(apiStarted);
    stage("production_smoke");
    const authenticated = await fetch("http://127.0.0.1:5000/api/videos/my-videos?limit=1", { headers: { Authorization: "Bearer " + savedToken }, signal: AbortSignal.timeout(15000) });
    assert.equal(authenticated.status, 200); assert.equal((await authenticated.json()).success, true); journal.existingSigningConfigurationAccepted = true;
    for (const base of ["http://127.0.0.1:5000", "https://api.talkmart.az"]) {
      const response = await fetch(base + "/api/videos/upload-init", { method: "POST", headers: { Authorization: "Bearer " + savedToken, "Content-Type": "application/json", "Idempotency-Key": "deployment-probe-" + crypto.randomUUID() },
        body: "{}", signal: AbortSignal.timeout(15000) });
      assert.equal(response.status, 400); assert.equal((await response.json()).error?.code, "INVALID_DIRECT_UPLOAD");
    }
    const feed = await fetch("https://api.talkmart.az/api/videos/feed?limit=1", { signal: AbortSignal.timeout(15000) }); assert.equal(feed.status, 200);
    const feedBody = await feed.json(); assert.equal(feedBody.success, true); const sample = (feedBody.data?.videos ?? feedBody.videos)?.[0];
    if (sample?.videoUrl) {
      const url = new URL(sample.videoUrl), expected = new URL(env.R2_PUBLIC_URL);
      must(url.origin === expected.origin && url.pathname.startsWith(expected.pathname.replace(/\/+$/, "") + "/") && !url.search, "PUBLIC_FEED_MEDIA_ORIGIN_MISMATCH");
      const range = await fetch(url, { headers: { Range: "bytes=0-1023" }, redirect: "manual", signal: AbortSignal.timeout(15000) });
      assert.equal(range.status, 206); must(Number(range.headers.get("content-length")) > 0 && Number(range.headers.get("content-length")) <= 1024, "PUBLIC_RANGE_RESPONSE_SIZE_INVALID");
      assert.match(range.headers.get("content-range"), /^bytes 0-\d+\/\d+$/); assert.equal(range.headers.get("content-type")?.split(";")[0], "video/mp4");
      const body = await range.arrayBuffer(); must(body.byteLength > 0 && body.byteLength <= 1024, "PUBLIC_RANGE_BODY_INVALID"); journal.publicMediaRangePassed = true;
    } else journal.publicFeedEmpty = true;
    await health("https://api.talkmart.az/health"); await health("https://api.talkmart.az/test-api/health"); unchangedTests();
    journal.processesAfter = safety.deploymentProcesses(list()); must(git(["rev-parse", "HEAD"]) === spec.releaseCommit && !git(["status", "--porcelain", "--untracked-files=no"]), "LIVE_RELEASE_CHANGED_AFTER_START");
    must(sameProductionEnv(parse(fs.readFileSync(LIVE + "/.env", "utf8")), parse(envBefore)), "LIVE_SECRETS_CHANGED");
    command("pm2", ["save"], "processes.log"); for (const filename of ["/root/.pm2/dump.pm2", "/root/.pm2/dump.pm2.bak"]) if (fs.existsSync(filename)) fs.chmodSync(filename, 0o600);
    must(read("systemctl", ["is-active", "pm2-root"]).trim() === "active", "PM2_SYSTEM_SERVICE_NOT_ACTIVE");
    stage("complete"); journal.completedAt = new Date().toISOString(); journal.directUploadEnabled = true; persist(); complete = true;
    console.log("Canli API, yeni worker heartbeat, auth ve public feed: OK");
    console.log(journal.publicMediaRangePassed ? "Public video Range: OK" : "Ictimai lent bosdur; public Range ucun numune yoxdur.");
    console.log("Direct upload canli backend-de aktivdir; evvelki multipart yol saxlanildi: OK");
    console.log("JWT/OTP/DB/xidmet acarlari ve test proseslerinin PID-leri saxlanildi: OK"); console.log("Canli buraxilis:", spec.releaseCommit);
  } catch (error) {
    recovering = true; const code = /^[A-Z_]+$/.test(error.message || "") ? error.message : error.code || error.name;
    console.error("Canli kecid [" + phase + "]:", code); if (journal) { journal.failure = { phase, code }; persist(); }
    if (paused && mongoose && before && envBefore && spec) {
      try {
        const safe = oldCodeRecoveryAllowed({ newWorkerMayHaveStarted, apiMayHaveAdmitted, sessions: await mongoose.connection.db.collection("uploadsessions").countDocuments(),
          currentCommit: git(["rev-parse", "HEAD"]), releaseCommit: spec.releaseCommit, trackedChanges: Boolean(git(["status", "--porcelain", "--untracked-files=no"])),
          envUnchanged: fs.realpathSync(LIVE + "/.env") === LIVE + "/.env" && sameProductionEnv(parse(fs.readFileSync(LIVE + "/.env", "utf8")), parse(envBefore)) });
        if (safe) {
          const filesChanged = git(["rev-parse", "HEAD"]) !== BASE || oldModulesMoved;
          if (filesChanged) for (const name of ["talkmart-api", "talkmart-worker"]) processAction("stop", name);
          canonicalLive(); if (git(["rev-parse", "HEAD"]) !== BASE) command("git", ["reset", "--hard", BASE], "recovery.log");
          if (oldModulesMoved) {
            if (newModulesMoved) { must(!fs.existsSync(modules.next), "RECOVERY_MODULE_TARGET_EXISTS"); fs.renameSync(modules.current, modules.next); }
            fs.renameSync(modules.before, modules.current);
          }
          fs.writeFileSync(LIVE + "/.env", envBefore, { mode: 0o600 }); fs.chmodSync(LIVE + "/.env", 0o600);
          const started = new Date();
          if (filesChanged || list().find(row => row.name === "talkmart-worker")?.pm2_env?.status !== "online") processAction("restart", "talkmart-worker");
          processAction("restart", "talkmart-api"); await readyApi(started);
          unchangedTests(); journal.recoveredOldCode = true; persist(); console.log("Yeni worker baslamamisdi; evvelki canli kod ve sazlama geri qaytarildi: OK");
        } else {
          processAction("stop", "talkmart-api");
          must(git(["rev-parse", "HEAD"]) === spec.releaseCommit && !git(["status", "--porcelain", "--untracked-files=no"]), "OPERATOR_CHANGED_LIVE_CODE");
          writeFlag(false); const started = new Date(); processAction("restart", "talkmart-api"); await readyApi(started);
          journal.newDirectInitDisabled = true; persist(); console.error("Yeni direct init baglandi; yeni kod, worker ve movcud melumatlar saxlanildi. Neticeni gonder.");
        }
      } catch (recoveryError) { console.error("Canli recovery:", /^[A-Z_]+$/.test(recoveryError.message || "") ? recoveryError.message : recoveryError.code || recoveryError.name); }
    }
    if (directory) console.error("Backup ve phase qeydi:", directory); process.exitCode = 1;
  } finally {
    savedToken = undefined;
    if (config) fs.rmSync(config, { force: true }); client?.destroy(); appStorage?.default?.destroy(); appStorage?.directR2?.destroy(); appRedis?.disconnect();
    if (mongoose) await mongoose.disconnect(); if (lockFd !== undefined) fs.closeSync(lockFd);
    if (complete) console.log("Canli kecid tamamlandi. Son production yoxlamasina hazirdir.");
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({ options: { apply: { type: "boolean", default: false }, help: { type: "boolean", default: false } } });
  if (!values.apply || values.help) console.log("Packaged production helper: node /root/talkmart-performance-cutover.mjs --apply\nDefault/help makes no changes. Requires the pinned preflight and already-recorded private-bucket confirmation.");
  else await applyCutover();
}
