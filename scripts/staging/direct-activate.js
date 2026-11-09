import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

const ROOT = "/var/www/backend-perf-test-20261108";
const ENV = "/var/www/backend-test/.env";
const BASE = "ffc1c33b193f9a6b31a8457cfab8482ffb8e75cb";
const NAMES = ["talkmart-api-test", "talkmart-worker-test"];
// Bound to the exact release manifest when producing the standalone artifact.
const MANIFEST_SHA256 = "__PACKAGE_MANIFEST_SHA256__";
const digest = filename => crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
export function validateDirectManifest(value) {
  if (value.kind !== "talkmart-direct-staging-release" || value.baseCommit !== BASE ||
      !/^[a-f0-9]{40}$/.test(value.releaseCommit || "") || value.releaseCommit === BASE ||
      !/^[a-f0-9]{64}$/.test(value.bundleSha256 || "") || !/^[a-f0-9]{64}$/.test(value.packageLockSha256 || "") ||
      !/^[a-f0-9]{64}$/.test(value.preflightScriptSha256 || "") ||
      !/^tmp\/direct-r2-preflight-[a-f0-9-]{36}\.json$/.test(value.preflightReport || "")) throw new Error("INVALID_DIRECT_RELEASE_MANIFEST");
  return value;
}
export function directFlagText(text, enabled) {
  if (typeof text !== "string" || typeof enabled !== "boolean") throw new Error("INVALID_DIRECT_ENV_UPDATE");
  return text + (text.endsWith("\n") ? "" : "\n") + `DIRECT_UPLOAD_ENABLED=${enabled}\n`;
}
export function directEnvUnchanged(current, original) {
  const values = value => Object.entries(value).filter(([key]) => key !== "DIRECT_UPLOAD_ENABLED").sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(values(current)) === JSON.stringify(values(original));
}
export function directRollbackAllowed({ activationMayHaveAdmitted, sessions, currentCommit, releaseCommit, trackedChanges, envUnchanged }) {
  return activationMayHaveAdmitted === false && sessions === 0 && trackedChanges === false && envUnchanged === true &&
    /^[a-f0-9]{40}$/.test(releaseCommit || "") && releaseCommit !== BASE && [BASE, releaseCommit].includes(currentCommit);
}

async function activate() {
  let mongoose, r2, directory, original, spec, envBefore, config, journal, lockFd, paused = false, activationMayHaveAdmitted = false, done = false;
  let cancelled = false, recovering = false, phase = "scope";
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => { cancelled = true; });
  const ensure = () => { if (cancelled && !recovering) throw new Error("DIRECT_ACTIVATION_INTERRUPTED"); };
  const read = (command, args) => execFileSync(command, args, { encoding: "utf8", timeout: 15000 });
  const lockHash = () => crypto.createHash("sha256").update(execFileSync("git", ["show", "HEAD:package-lock.json"])).digest("hex");
  const list = () => JSON.parse(read("pm2", ["jlist"]));
  let assertProductionUnchanged, processSnapshot, mediaInventory, parse;
  const persist = () => {
    if (!journal || !directory) return;
    Object.assign(journal, { phase, activationMayHaveAdmitted, updatedAt: new Date().toISOString() });
    const temporary = path.join(directory, "manifest.next.json");
    fs.writeFileSync(temporary, JSON.stringify(journal, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temporary, path.join(directory, "manifest.json"));
  };
  const stage = name => { ensure(); phase = name; persist(); };
  const run = (command, args, logfile = "operations.log", timeout = 300000) => {
    ensure();
    const fd = fs.openSync(path.join(directory, logfile), "a", 0o600);
    try { execFileSync(command, args, { timeout, stdio: ["ignore", fd, fd] }); } finally { fs.closeSync(fd); }
  };
  const pm2 = (action, name) => {
    if (!NAMES.includes(name) || !["stop", "restart"].includes(action)) throw new Error("ONLY_TEST_PROCESS_ACTIONS_ALLOWED");
    const current = list(), matches = current.filter(item => item.name === name);
    if (matches.length !== 1 || matches[0].pm2_env?.pm_cwd !== ROOT || matches[0].pm2_env?.pm_exec_path !== ROOT + `/scripts/staging/${name.includes("worker") ? "worker" : "api"}.js`) throw new Error("UNEXPECTED_TEST_PROCESS");
    assertProductionUnchanged(original, current); run("pm2", [action, name], "processes.log", 330000);
  };
  const quiescent = async () => {
    const db = mongoose.connection.db;
    if (await db.collection("videos").countDocuments({ $or: [
      { processingStatus: { $in: ["uploaded", "queued", "processing", "deleting"] } }, { status: "deleting" },
      { mediaPublicationId: { $ne: null } }, { mediaRevocationPending: true }, { "publicDeletionKeys.0": { $exists: true } },
    ] }) || await db.collection("users").countDocuments({ $or: [{ accountStatus: "deleting" },
      { uploadReservation: { $type: "string", $ne: "" }, uploadReservedUntil: { $gt: new Date() } }] }) ||
        await db.collection("uploadsessions").countDocuments()) throw new Error("TEST_JOBS_OR_DIRECT_SESSIONS_PENDING");
  };
  const setFlag = enabled => {
    if (fs.realpathSync(ENV) !== ENV) throw new Error("STAGING_ENV_PATH_CHANGED");
    const current = fs.readFileSync(ENV, "utf8"), updated = directFlagText(current, enabled);
    const before = parse(current), after = parse(updated);
    if (envBefore && !directEnvUnchanged(before, parse(envBefore.toString("utf8")))) throw new Error("STAGING_ENV_CHANGED_OUTSIDE_DEPLOYMENT");
    if (JSON.stringify({ ...before, DIRECT_UPLOAD_ENABLED: String(enabled) }) !== JSON.stringify(after)) throw new Error("UNEXPECTED_ENV_VALUE_CHANGE");
    const temporary = ENV + ".direct-" + crypto.randomUUID();
    fs.writeFileSync(temporary, updated, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, ENV); fs.chmodSync(ENV, 0o600);
  };
  const health = async url => {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (response.status !== 200 || (await response.json()).status !== "ok") throw new Error("DIRECT_TEST_HEALTH_FAILED");
  };
  const waitApi = async () => {
    const until = Date.now() + 60000;
    while (Date.now() < until) { ensure(); try { await health("http://127.0.0.1:5001/health"); return; } catch { await delay(1000); } }
    throw new Error("NEW_TEST_API_NOT_READY");
  };
  const waitWorker = async started => {
    const until = Date.now() + 120000;
    while (Date.now() < until) {
      ensure(); assertProductionUnchanged(original, list());
      const worker = list().find(item => item.name === "talkmart-worker-test");
      if (worker?.pm2_env?.status === "online" && worker.pm2_env.pm_uptime >= started.getTime() && await mongoose.connection.db.collection("workerstatuses").findOne({ _id: new RegExp("^" + worker.pid + "-"), heartbeatAt: { $gte: started } })) return;
      await delay(1000);
    }
    throw new Error("NEW_TEST_WORKER_HEARTBEAT_MISSING");
  };
  try {
    if (process.platform !== "linux" || !["/root/direct-upload-activate.mjs", ROOT + "/scripts/staging/direct-activate.js"].includes(fs.realpathSync(fileURLToPath(import.meta.url))) ||
        fs.realpathSync(ROOT) !== ROOT || !/^[a-f0-9]{64}$/.test(MANIFEST_SHA256)) throw new Error("PACKAGED_LINUX_STAGING_HELPER_REQUIRED");
    phase = "exclusive_lock";
    lockFd = fs.openSync("/root/talkmart-direct-activation.lock", fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
    if (!fs.fstatSync(lockFd).isFile()) throw new Error("INVALID_ACTIVATION_LOCK_FILE");
    fs.fchmodSync(lockFd, 0o600);
    // flock on inherited fd 3 shares the parent's open file description. The
    // kernel releases this lock when the parent fd closes, including SIGKILL.
    try { execFileSync("flock", ["-n", "3"], { stdio: ["ignore", "ignore", "ignore", lockFd] }); }
    catch (error) { throw new Error(error.code === "ENOENT" ? "FLOCK_NOT_AVAILABLE" : "DIRECT_ACTIVATION_BUSY"); }
    fs.ftruncateSync(lockFd, 0); fs.writeFileSync(lockFd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + "\n");
    process.chdir(ROOT);
    if (digest("/root/talkmart-direct-release.json") !== MANIFEST_SHA256) throw new Error("RELEASE_MANIFEST_CHECKSUM_MISMATCH");
    spec = validateDirectManifest(JSON.parse(fs.readFileSync("/root/talkmart-direct-release.json", "utf8")));
    if (digest("/root/talkmart-direct-upload.bundle") !== spec.bundleSha256) throw new Error("RELEASE_BUNDLE_CHECKSUM_MISMATCH");
    if (read("git", ["rev-parse", "HEAD"]).trim() !== BASE || read("git", ["status", "--porcelain", "--untracked-files=no"]).trim()) throw new Error("STAGING_BASE_OR_TRACKED_CODE_CHANGED");
    if (lockHash() !== spec.packageLockSha256 || fs.realpathSync(ENV) !== ENV) throw new Error("DEPENDENCIES_OR_ENV_PATH_CHANGED");
    const require = createRequire(path.join(ROOT, "package.json"));
    mongoose = require("mongoose"); ({ parse } = require("dotenv"));
    const { openStaging } = await import(pathToFileURL(path.join(ROOT, "scripts/staging/safety.js")));
    ({ processSnapshot, assertProductionUnchanged, mediaInventory } = await import(pathToFileURL(path.join(ROOT, "scripts/staging/rollout-safety.js"))));
    await openStaging(); original = processSnapshot(list(), "new"); await quiescent();
    const reportPath = path.join(ROOT, spec.preflightReport);
    if (fs.realpathSync(reportPath) !== reportPath || digest("tmp/direct-r2-preflight.mjs") !== spec.preflightScriptSha256) throw new Error("R2_PREFLIGHT_FILE_CHANGED");
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    const checks = ["signedLengthRejected", "expiredUrlRejected", "multipartAndHead", "completedPartUrlRejected", "byteIdentical", "ownedObjectAndMultipartCleaned", "allProcessIdsPreserved"];
    const age = Date.now() - new Date(report.finishedAt).getTime();
    if (report.kind !== "direct-r2-compatibility-preflight" || !report.passed || !Number.isFinite(age) || age < -60000 || age > 86400000 || checks.some(name => report.checks?.[name] !== true)) throw new Error("FRESH_PASSED_R2_PREFLIGHT_REQUIRED");
    await health("https://api.talkmart.az/health"); await health("https://api.talkmart.az/test-api/health");
    read("mongodump", ["--version"]); read("mongorestore", ["--version"]);
    fs.mkdirSync("/root/talkmart-backups", { recursive: true, mode: 0o700 });
    directory = fs.mkdtempSync("/root/talkmart-backups/direct-staging-" + new Date().toISOString().replace(/[:.]/g, "-") + "-");
    if (path.dirname(fs.realpathSync(directory)) !== "/root/talkmart-backups") throw new Error("UNEXPECTED_BACKUP_DIRECTORY");
    fs.chmodSync(directory, 0o700); envBefore = fs.readFileSync(ENV);
    journal = { kind: "talkmart-direct-staging-backup", id: crypto.randomUUID(), startedAt: new Date().toISOString(), baseCommit: BASE,
      releaseCommit: spec.releaseCommit, database: "talkmart_staging", processesBefore: original, files: {}, objects: [], backupComplete: false };
    persist();
    run("git", ["bundle", "verify", "/root/talkmart-direct-upload.bundle"]);
    stage("pause_test_processes"); paused = true; pm2("stop", "talkmart-api-test"); pm2("stop", "talkmart-worker-test");
    await quiescent(); assertProductionUnchanged(original, list());
    console.log("Yalniz test API ve worker dayandirildi: OK");
    stage("backup");
    config = path.join(directory, ".mongo-config.yml"); fs.writeFileSync(config, `uri: ${JSON.stringify(process.env.MONGO_URI)}\n`, { mode: 0o600, flag: "wx" });
    run("tar", ["--exclude=./node_modules", "--exclude=./.git", "--exclude=./tmp/performance", "-czf", path.join(directory, "code.tar.gz"), "-C", ROOT, "."]);
    run("git", ["bundle", "create", path.join(directory, "code.bundle"), "--all"]);
    fs.writeFileSync(path.join(directory, "settings.env"), envBefore, { mode: 0o600 });
    run("mongodump", ["--config=" + config, "--db=talkmart_staging", "--archive=" + path.join(directory, "mongodb-staging.archive.gz"), "--gzip"], "mongodump.log");
    run("gzip", ["-t", path.join(directory, "code.tar.gz"), path.join(directory, "mongodb-staging.archive.gz")]);
    run("mongorestore", ["--config=" + config, "--archive=" + path.join(directory, "mongodb-staging.archive.gz"), "--gzip", "--nsInclude=talkmart_staging.*", "--dryRun"], "restore-preview.log");
    for (const name of ["code.tar.gz", "code.bundle", "settings.env", "mongodb-staging.archive.gz"]) { fs.chmodSync(path.join(directory, name), 0o600); journal.files[name] = digest(path.join(directory, name)); }
    const { S3Client, HeadObjectCommand, CopyObjectCommand } = require("@aws-sdk/client-s3");
    r2 = new S3Client({ region: "auto", endpoint: process.env.R2_ENDPOINT, credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY } });
    const videos = await mongoose.connection.db.collection("videos").find().limit(1001).toArray(), users = await mongoose.connection.db.collection("users").find().limit(201).toArray();
    if (videos.length > 1000 || users.length > 200) throw new Error("STAGING_BACKUP_TOO_LARGE");
    stage("private_media_backup");
    for (const key of mediaInventory(videos, users, process.env.R2_PUBLIC_URL)) {
      ensure(); const bucket = key.startsWith("talkmart/staging/") || key.startsWith("talkmart/private/") ? process.env.R2_STAGING_BUCKET : process.env.R2_BUCKET;
      const backupKey = `talkmart/private/rollout-backups/${journal.id}/${bucket}/${key}`;
      let head;
      try { head = await r2.send(new HeadObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(15000) }); }
      catch (error) { if (error.name === "NotFound" || error.$metadata?.httpStatusCode === 404) { journal.objects.push({ bucket, key, backupKey, missing: true }); persist(); continue; } throw error; }
      await r2.send(new CopyObjectCommand({ Bucket: process.env.R2_STAGING_BUCKET, Key: backupKey,
        CopySource: [bucket, ...key.split("/")].map(encodeURIComponent).join("/"), CopySourceIfMatch: head.ETag,
        MetadataDirective: "REPLACE", ContentType: head.ContentType || "application/octet-stream", CacheControl: "private, no-store" }), { abortSignal: AbortSignal.timeout(120000) });
      const copied = await r2.send(new HeadObjectCommand({ Bucket: process.env.R2_STAGING_BUCKET, Key: backupKey }), { abortSignal: AbortSignal.timeout(15000) });
      if (copied.ContentLength !== head.ContentLength) throw new Error("MEDIA_BACKUP_SIZE_MISMATCH");
      journal.objects.push({ bucket, key, backupKey, bytes: head.ContentLength, contentType: head.ContentType, cacheControl: head.CacheControl, metadata: head.Metadata || {} }); persist();
    }
    journal.backupComplete = true; persist();
    console.log("Test kodu, baza, sazlama ve private media backup-i: OK"); console.log("Ehtiyat nusxe:", directory);
    stage("fast_forward_code");
    run("git", ["fetch", "/root/talkmart-direct-upload.bundle", "refs/heads/codex/performance-baseline"]);
    if (read("git", ["rev-parse", "FETCH_HEAD"]).trim() !== spec.releaseCommit) throw new Error("UNEXPECTED_RELEASE_REF");
    run("git", ["merge", "--ff-only", "FETCH_HEAD"]);
    if (lockHash() !== spec.packageLockSha256) throw new Error("UNEXPECTED_DEPENDENCY_CHANGE");
    run("npm", ["run", "lint"], "source-check.log"); run("npm", ["test"], "unit-tests.log");
    console.log("Source ve unit/media/staging yoxlamalari: OK");
    stage("start_disabled_new_code"); setFlag(false);
    const started = new Date(); pm2("restart", "talkmart-worker-test"); await waitWorker(started);
    pm2("restart", "talkmart-api-test"); await waitApi(); processSnapshot(list(), "new");
    const provider = await mongoose.connection.db.collection("users").findOne({ _id: new mongoose.Types.ObjectId("6adfd4c4eefbfb98a5fbfa2e"), email: "provider@talkmart-test.invalid", role: "provider", emailVerified: true, isBlocked: false, "providerProfile.verified": true, accountStatus: { $ne: "deleting" } });
    if (!provider) throw new Error("STAGING_PROVIDER_UNAVAILABLE");
    const { signAccessToken } = await import(pathToFileURL(path.join(ROOT, "src/utils/jwt.js")));
    const token = signAccessToken({ id: String(provider._id), sv: provider.sessionVersion ?? 1 });
    const probe = async (url, enabled) => {
      const response = await fetch(url, { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", "Idempotency-Key": "deploy-probe-" + crypto.randomUUID() }, body: "{}", signal: AbortSignal.timeout(15000) });
      const body = await response.json();
      if (response.status !== (enabled ? 400 : 503) || body.error?.code !== (enabled ? "INVALID_DIRECT_UPLOAD" : "DIRECT_UPLOAD_DISABLED")) throw new Error("DIRECT_FEATURE_PROBE_FAILED");
    };
    await probe("http://127.0.0.1:5001/api/videos/upload-init", false);
    await quiescent();
    stage("enable_test_direct_upload"); setFlag(true); activationMayHaveAdmitted = true; persist();
    pm2("restart", "talkmart-api-test"); await waitApi();
    await probe("http://127.0.0.1:5001/api/videos/upload-init", true);
    await probe("https://api.talkmart.az/test-api/api/videos/upload-init", true);
    await health("https://api.talkmart.az/test-api/health"); await health("https://api.talkmart.az/health");
    assertProductionUnchanged(original, list()); journal.processesAfter = processSnapshot(list(), "new");
    if (read("git", ["rev-parse", "HEAD"]).trim() !== spec.releaseCommit) throw new Error("RELEASE_CODE_CHANGED");
    run("pm2", ["save"], "processes.log"); fs.chmodSync("/root/.pm2/dump.pm2", 0o600);
    stage("complete"); journal.activatedAt = new Date().toISOString(); persist(); done = true;
    console.log("Yeni test worker heartbeat ve API: OK"); console.log("Birbasa upload yalniz test muhitinde aktivdir: OK");
    console.log("Canli API/worker PID-leri saxlanildi: OK"); console.log("Test buraxilisi:", spec.releaseCommit);
  } catch (error) {
    recovering = true;
    console.error("Direct test kecidi [" + phase + "]:", /^[A-Z_]+$/.test(error.message || "") ? error.message : error.code || error.name);
    if (paused && mongoose && original) {
      try {
        const sessions = await mongoose.connection.db.collection("uploadsessions").countDocuments();
        if (directRollbackAllowed({ activationMayHaveAdmitted, sessions, currentCommit: read("git", ["rev-parse", "HEAD"]).trim(), releaseCommit: spec.releaseCommit,
          trackedChanges: Boolean(read("git", ["status", "--porcelain", "--untracked-files=no"]).trim()),
          envUnchanged: fs.realpathSync(ENV) === ENV && directEnvUnchanged(parse(fs.readFileSync(ENV, "utf8")), parse(envBefore.toString("utf8"))) })) {
          for (const name of NAMES) pm2("stop", name);
          if (read("git", ["rev-parse", "HEAD"]).trim() !== BASE) run("git", ["reset", "--hard", BASE], "recovery.log");
          fs.writeFileSync(ENV, envBefore, { mode: 0o600 }); fs.chmodSync(ENV, 0o600);
          for (const name of [...NAMES].reverse()) pm2("restart", name);
          await waitApi(); assertProductionUnchanged(original, list()); journal.recoveredOldCode = true; persist();
          console.log("Evvelki test kodu ve sazlama ile API/worker yeniden acildi: OK");
        } else {
          // New sessions may exist. Preserve their worker/cleanup code and close
          // admission; never restore a pre-upload DB snapshot automatically.
          pm2("stop", "talkmart-api-test"); setFlag(false);
          if (read("git", ["rev-parse", "HEAD"]).trim() !== spec.releaseCommit || read("git", ["status", "--porcelain", "--untracked-files=no"]).trim()) throw new Error("TEST_CODE_CHANGED_DURING_DEPLOYMENT");
          pm2("restart", "talkmart-api-test");
          journal.newInitDisabled = true; persist();
          console.error("Yeni init baglandi; yeni kod ve movcud upload-lar saxlanildi. Neticeni gonder.");
        }
      } catch (recoveryError) { console.error("Test recovery:", recoveryError.code || recoveryError.name); }
    }
    if (directory) console.error("Backup ve qeydlər:", directory);
    process.exitCode = 1;
  } finally {
    if (config) fs.rmSync(config, { force: true }); r2?.destroy(); if (mongoose) await mongoose.disconnect();
    if (lockFd !== undefined) fs.closeSync(lockFd);
    if (done) console.log("Kecid tamamlandi. Yeni real direct upload sinagi ucun hazirdir.");
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({ options: { activate: { type: "boolean", default: false }, help: { type: "boolean", default: false } } });
  if (!values.activate || values.help) console.log("Packaged staging helper: node /root/direct-upload-activate.mjs --activate\nDefault/help makes no changes.");
  else await activate();
}
