import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import mongoose from "mongoose";
import { HeadObjectCommand, CopyObjectCommand } from "@aws-sdk/client-s3";
import { openStaging } from "./safety.js";
import { oldDirectory, newDirectory, managedNames, processSnapshot, assertProductionUnchanged, mediaInventory, assertBackupPath, assertBackupManifest } from "./rollout-safety.js";

const { values } = parseArgs({ options: { deploy: { type: "boolean", default: false }, "rollback-backup": { type: "string" }, apply: { type: "boolean", default: false }, help: { type: "boolean", default: false } } });
if (values.help) { console.log("node scripts/staging/rollout.js --deploy\nnode scripts/staging/rollout.js --rollback-backup=/root/talkmart-backups/perf-staging-... [--apply]\nStaging DB, buckets and named test processes only. Rollback is a preview unless --apply is explicit."); process.exit(0); }
if (Number(values.deploy) + Number(Boolean(values["rollback-backup"])) !== 1 || (values.deploy && values.apply)) throw new Error("CHOOSE_DEPLOY_OR_ROLLBACK");
const read = (command, args) => execFileSync(command, args, { encoding: "utf8", timeout: 15000, windowsHide: true });
const list = () => JSON.parse(read("pm2", ["jlist"]));
const digest = filename => crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
let directory, config, r2, original, manifest, paused = false, workerMayHaveStarted = false, success = false, stage = "settings";
let cancelled = false, recovering = false;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => { cancelled = true; });
const ensureRunning = () => { if (cancelled && !recovering) throw new Error("STAGING_OPERATION_INTERRUPTED"); };
const save = () => {
  const temporary = path.join(directory, "manifest.next.json");
  fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temporary, path.join(directory, "manifest.json"));
};
function run(command, args, logName, timeout = 300000) {
  ensureRunning();
  const fd = fs.openSync(path.join(directory, logName), "a", 0o600);
  try { execFileSync(command, args, { timeout, stdio: ["ignore", fd, fd] }); }
  finally { fs.closeSync(fd); }
}
function pm2(action, name, script, cwd) {
  if (!managedNames.includes(name)) throw new Error("NOT_A_MANAGED_TEST_PROCESS");
  const args = action === "start" ? ["start", script, "--name", name, "--cwd", cwd, "--kill-timeout", name.includes("worker") ? "300000" : "15000"] : [action, name];
  run("pm2", args, "processes.log");
}
async function fetchHealth(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (response.status !== 200 || (await response.json()).status !== "ok") throw new Error("HEALTH_CHECK_FAILED");
}
async function healthy() {
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    ensureRunning();
    try { await fetchHealth("http://127.0.0.1:5001/health"); return; } catch { await delay(1000); }
  }
  throw new Error("TEST_API_NOT_READY");
}
async function quiescent() {
  const db = mongoose.connection.db;
  if (await db.collection("videos").countDocuments({ $or: [
    { processingStatus: { $in: ["uploaded", "queued", "processing", "deleting"] } }, { status: "deleting" },
    { mediaPublicationId: { $ne: null } }, { mediaRevocationPending: true }, { "publicDeletionKeys.0": { $exists: true } },
  ] }) || await db.collection("users").countDocuments({ accountStatus: "deleting" })) throw new Error("TEST_JOBS_OR_CLEANUP_STILL_PENDING");
}
const copy = (sourceBucket, sourceKey, targetBucket, targetKey, metadata = {}) => {
  ensureRunning();
  return r2.send(new CopyObjectCommand({
    Bucket: targetBucket, Key: targetKey, CopySource: [sourceBucket, ...sourceKey.split("/")].map(encodeURIComponent).join("/"),
    MetadataDirective: "REPLACE", ...metadata,
  }), { abortSignal: AbortSignal.timeout(120000) });
};
async function verifyArchive() {
  for (const [filename, hash] of Object.entries(manifest.files)) {
    if (!["backend-test.tar.gz", "backend-test.bundle", "mongodb-staging.archive.gz", "settings.env"].includes(filename) || digest(path.join(directory, filename)) !== hash) throw new Error("BACKUP_CHECKSUM_MISMATCH");
  }
  run("gzip", ["-t", path.join(directory, "mongodb-staging.archive.gz"), path.join(directory, "backend-test.tar.gz")], "verify.log");
  run("mongorestore", ["--config=" + config, "--archive=" + path.join(directory, "mongodb-staging.archive.gz"), "--gzip", "--nsInclude=talkmart_staging.*", "--dryRun"], "restore-preview.log");
}
async function startOld() {
  for (const name of managedNames) {
    if (list().some(item => item.name === name)) pm2("delete", name);
    pm2("start", name, oldDirectory + `/tmp/start-test-${name.includes("worker") ? "worker" : "api"}.mjs`, oldDirectory);
  }
  await healthy(); processSnapshot(list(), "old");
}
try {
  await openStaging();
  ensureRunning();
  r2 = (await import("../../src/config/r2.js")).default;
  if (values.deploy) {
    stage = "process_guards";
    original = processSnapshot(list(), "old");
    if (read("git", ["status", "--porcelain", "--untracked-files=no"]).trim() || read("git", ["-C", oldDirectory, "status", "--porcelain", "--untracked-files=no"]).trim()) throw new Error("TRACKED_CODE_CHANGED");
    await quiescent();
    read("mongodump", ["--version"]); read("mongorestore", ["--version"]);
    await fetchHealth("https://api.talkmart.az/health");
    fs.mkdirSync("/root/talkmart-backups", { recursive: true, mode: 0o700 });
    directory = fs.mkdtempSync("/root/talkmart-backups/perf-staging-" + new Date().toISOString().replace(/[:.]/g, "-") + "-");
    fs.chmodSync(directory, 0o700); assertBackupPath(directory);
    manifest = { kind: "talkmart-staging-rollback", id: crypto.randomUUID(), database: "talkmart_staging", complete: false,
      startedAt: new Date().toISOString(), oldCommit: read("git", ["-C", oldDirectory, "rev-parse", "HEAD"]).trim(),
      releaseCommit: read("git", ["rev-parse", "HEAD"]).trim(), processes: original, envHash: digest(oldDirectory + "/.env"), objects: [], files: {}, helperHashes: {} };
    for (const name of ["start-test-api.mjs", "start-test-worker.mjs", "test-safety.mjs"]) manifest.helperHashes[name] = digest(oldDirectory + "/tmp/" + name);
    save();
    config = path.join(directory, `.mongo-config-${crypto.randomUUID()}.yml`);
    fs.writeFileSync(config, `uri: ${JSON.stringify(process.env.MONGO_URI)}\n`, { mode: 0o600, flag: "wx" });
    stage = "pause_test_only"; paused = true;
    for (const name of managedNames) pm2("stop", name);
    await quiescent(); assertProductionUnchanged(original, list());
    console.log("Yalnız köhnə test API/worker dayandırıldı. Canlı proseslər dəyişməyib: OK");
    stage = "database_backup";
    run("tar", ["--exclude=./node_modules", "--exclude=./.git", "-czf", path.join(directory, "backend-test.tar.gz"), "-C", oldDirectory, "."], "archive.log");
    run("git", ["-C", oldDirectory, "bundle", "create", path.join(directory, "backend-test.bundle"), "--all"], "archive.log");
    fs.copyFileSync(oldDirectory + "/.env", path.join(directory, "settings.env")); fs.chmodSync(path.join(directory, "settings.env"), 0o600);
    run("mongodump", ["--config=" + config, "--db=talkmart_staging", "--archive=" + path.join(directory, "mongodb-staging.archive.gz"), "--gzip"], "mongodump.log");
    for (const filename of ["backend-test.tar.gz", "backend-test.bundle", "mongodb-staging.archive.gz", "settings.env"]) {
      fs.chmodSync(path.join(directory, filename), 0o600); manifest.files[filename] = digest(path.join(directory, filename));
    }
    await verifyArchive(); console.log("Test kodu, baza və sazlamanın yoxlanmış backup-ı: OK");
    stage = "media_backup";
    const videos = await mongoose.connection.db.collection("videos").find().limit(1001).toArray(), users = await mongoose.connection.db.collection("users").find().limit(201).toArray();
    if (videos.length > 1000 || users.length > 200) throw new Error("TEST_BACKUP_TOO_LARGE");
    const { bucketFor } = await import("../../src/services/r2Upload.service.js");
    for (const key of mediaInventory(videos, users, process.env.R2_PUBLIC_URL)) {
      const bucket = bucketFor(key), backupKey = `talkmart/private/rollout-backups/${manifest.id}/${bucket}/${key}`;
      let metadata;
      try { metadata = await r2.send(new HeadObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(15000) }); }
      catch (error) { if (error.name === "NotFound" || error.$metadata?.httpStatusCode === 404) { manifest.objects.push({ bucket, key, backupKey, missing: true }); save(); continue; } throw error; }
      await copy(bucket, key, process.env.R2_STAGING_BUCKET, backupKey, { ContentType: metadata.ContentType || "application/octet-stream", CacheControl: "private, no-store", CopySourceIfMatch: metadata.ETag });
      const backedUp = await r2.send(new HeadObjectCommand({ Bucket: process.env.R2_STAGING_BUCKET, Key: backupKey }), { abortSignal: AbortSignal.timeout(15000) });
      if (metadata.ContentLength !== backedUp.ContentLength) throw new Error("MEDIA_BACKUP_SIZE_MISMATCH");
      manifest.objects.push({ bucket, key, backupKey, bytes: metadata.ContentLength, contentType: metadata.ContentType, cacheControl: metadata.CacheControl }); save();
    }
    manifest.complete = true; save(); assertBackupManifest(manifest);
    console.log("Private media backup-ı: OK. Saxlanılan obyekt:", manifest.objects.filter(item => !item.missing).length);
    if (manifest.objects.some(item => item.missing)) console.log("Backup-dan əvvəl storage-də olmayan istinad:", manifest.objects.filter(item => item.missing).length);
    console.log("Ehtiyat nüsxə:", directory);
    stage = "start_new_test_worker";
    for (const name of managedNames) pm2("delete", name);
    workerMayHaveStarted = true;
    const workerStartedAt = new Date();
    pm2("start", "talkmart-worker-test", newDirectory + "/scripts/staging/worker.js", newDirectory);
    const until = Date.now() + 120000;
    let ready = false;
    while (Date.now() < until) {
      ensureRunning();
      const worker = list().find(item => item.name === "talkmart-worker-test");
      if (worker?.pm2_env?.status === "online" && await mongoose.connection.db.collection("workerstatuses").findOne({ _id: new RegExp("^" + worker.pid + "-"), heartbeatAt: { $gte: workerStartedAt } })) { ready = true; break; }
      await delay(1000);
    }
    if (!ready) throw new Error("NEW_TEST_WORKER_HEARTBEAT_MISSING");
    stage = "start_new_test_api";
    pm2("start", "talkmart-api-test", newDirectory + "/scripts/staging/api.js", newDirectory);
    await healthy(); processSnapshot(list(), "new"); assertProductionUnchanged(original, list());
    await fetchHealth("https://api.talkmart.az/test-api/health"); await fetchHealth("https://api.talkmart.az/health");
    run("pm2", ["save"], "processes.log"); fs.chmodSync("/root/.pm2/dump.pm2", 0o600);
    manifest.deployedAt = new Date().toISOString(); save(); success = true;
    console.log("Yeni test API, worker heartbeat və /test-api/health: OK");
    console.log("Canlı API/worker PID-ləri saxlanıldı: OK");
    console.log("Test buraxılışı:", manifest.releaseCommit);
  } else {
    directory = values["rollback-backup"]; assertBackupPath(directory);
    if (fs.realpathSync(directory) !== directory) throw new Error("BACKUP_SYMLINK_NOT_ALLOWED");
    manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8")); assertBackupManifest(manifest);
    if (digest(oldDirectory + "/.env") !== manifest.envHash || read("git", ["-C", oldDirectory, "rev-parse", "HEAD"]).trim() !== manifest.oldCommit || read("git", ["-C", oldDirectory, "status", "--porcelain", "--untracked-files=no"]).trim()) throw new Error("OLD_TEST_CODE_OR_SETTINGS_CHANGED");
    for (const [name, hash] of Object.entries(manifest.helperHashes)) {
      if (!["start-test-api.mjs", "start-test-worker.mjs", "test-safety.mjs"].includes(name) || digest(oldDirectory + "/tmp/" + name) !== hash) throw new Error("OLD_TEST_HELPER_CHANGED");
    }
    config = path.join(directory, `.mongo-config-${crypto.randomUUID()}.yml`);
    fs.writeFileSync(config, `uri: ${JSON.stringify(process.env.MONGO_URI)}\n`, { mode: 0o600, flag: "wx" });
    await verifyArchive();
    for (const item of manifest.objects.filter(item => !item.missing)) {
      const stored = await r2.send(new HeadObjectCommand({ Bucket: process.env.R2_STAGING_BUCKET, Key: item.backupKey }), { abortSignal: AbortSignal.timeout(15000) });
      if (stored.ContentLength !== item.bytes) throw new Error("MEDIA_BACKUP_CHANGED");
    }
    console.log("Geri dönüş backup-ı yoxlandı. Baza: talkmart_staging. Media:", manifest.objects.filter(item => !item.missing).length);
    if (!values.apply) { console.log("Bu, yalnız geri dönüş önizləməsidir. Heç nə bərpa edilmədi."); success = true; }
    else {
      stage = "rollback_apply";
      const current = list();
      original = processSnapshot(current, "old", ["talkmart-api", "talkmart-worker"]);
      for (const name of managedNames) {
        const app = current.find(item => item.name === name);
        if (app) {
          const cwd = app.pm2_env?.pm_cwd;
          const script = cwd === oldDirectory ? `/tmp/start-test-${name.includes("worker") ? "worker" : "api"}.mjs` : `/scripts/staging/${name.includes("worker") ? "worker" : "api"}.js`;
          if (![oldDirectory, newDirectory].includes(cwd) || app.pm2_env.pm_exec_path !== cwd + script || current.filter(item => item.name === name).length !== 1) throw new Error("ROLLBACK_TEST_PROCESS_MISMATCH");
        }
      }
      for (const name of managedNames) if (current.some(item => item.name === name)) pm2("stop", name);
      for (const item of manifest.objects.filter(item => !item.missing)) await copy(process.env.R2_STAGING_BUCKET, item.backupKey, item.bucket, item.key,
        { ContentType: item.contentType || "application/octet-stream", ...(item.cacheControl ? { CacheControl: item.cacheControl } : {}) });
      run("mongorestore", ["--config=" + config, "--archive=" + path.join(directory, "mongodb-staging.archive.gz"), "--gzip", "--nsInclude=talkmart_staging.*", "--drop"], "restore.log");
      await startOld(); assertProductionUnchanged(original, list()); await fetchHealth("https://api.talkmart.az/test-api/health");
      run("pm2", ["save"], "processes.log"); fs.chmodSync("/root/.pm2/dump.pm2", 0o600); success = true;
      console.log("Köhnə test kodu, baza və media bərpa edildi: OK");
    }
  }
} catch (error) {
  recovering = true;
  console.error("Test keçidi tamamlanmadı [" + stage + "]:", /^[A-Z][A-Z0-9_]*(?:talkmart-[a-z-]+)?$/.test(error.message || "") ? error.message : error.code || error.name);
  if (paused && !workerMayHaveStarted) {
    try { await startOld(); console.log("Köhnə test API/worker yenidən işləyir: OK"); }
    catch { console.error("Köhnə test proseslərini açmaq alınmadı. Yalnız test mühiti dayana bilər."); }
  } else if (workerMayHaveStarted) {
    for (const name of managedNames) { try { if (list().some(item => item.name === name)) pm2("stop", name); } catch {} }
    console.error("Yeni test prosesləri saxlanıldı. Yenidən işlətmədən nəticəni göndər.");
  }
  if (directory) console.error("Backup və yerli qeydlər:", directory);
  process.exitCode = 1;
} finally {
  if (config) fs.rmSync(config, { force: true });
  r2?.destroy(); await mongoose.disconnect();
  if (values.deploy && success) console.log("Keçid yalnız test mühitinə tətbiq olundu.");
}
