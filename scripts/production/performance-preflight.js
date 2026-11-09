import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const LIVE = "/var/www/backend-release-20261106";
export const CANDIDATE = "/var/www/backend-release-20261110";
export const STAGING = "/var/www/backend-perf-test-20261108";
export const BASE = "94cc79d5d57365fcd41aeecb576587e49dcc19b3";
const MANIFEST_SHA256 = "__PACKAGE_MANIFEST_SHA256__";
const sha = input => crypto.createHash("sha256").update(input).digest("hex");
const fileSha = filename => sha(fs.readFileSync(filename));
const requireValue = (condition, code) => { if (!condition) throw new Error(code); };
export function validatePerformanceManifest(value) {
  requireValue(value?.kind === "talkmart-production-performance-release" && value.baseCommit === BASE &&
    /^[a-f0-9]{40}$/.test(value.releaseCommit || "") && value.releaseCommit !== BASE &&
    /^[a-f0-9]{64}$/.test(value.bundleSha256 || "") && /^[a-f0-9]{64}$/.test(value.packageLockSha256 || "") &&
    /^[a-f0-9]{40}$/.test(value.runtimeSrcTree || ""), "INVALID_PRODUCTION_RELEASE_MANIFEST");
  return value;
}
export function validateProductionSettings(env, staging) {
  requireValue(env.R2_BUCKET === "talkmart" && env.R2_STAGING_BUCKET === "talkmart-staging" &&
    String(env.PORT || "5000") === "5000" && env.NODE_ENV === "production" && env.TRUST_PROXY === "loopback", "PRODUCTION_SCOPE_MISMATCH");
  for (const key of ["MONGO_URI", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_PUBLIC_URL", "GEMINI_MODEL"]) requireValue(Boolean(env[key]), "PRODUCTION_CONFIGURATION_MISSING");
  for (const key of ["JWT_SECRET", "OTP_PEPPER"]) requireValue((env[key] || "").length >= 32, "PRODUCTION_SIGNING_CONFIGURATION_INVALID");
  for (const key of ["JWT_ACCESS_SECRET", "JWT_RESET_SECRET"]) if (env[key]) requireValue(env[key].length >= 32, "PRODUCTION_SIGNING_CONFIGURATION_INVALID");
  const liveKeys = [env.JWT_SECRET, env.JWT_ACCESS_SECRET, env.JWT_RESET_SECRET].filter(Boolean);
  const stageKeys = [staging.JWT_SECRET, staging.JWT_ACCESS_SECRET, staging.JWT_RESET_SECRET].filter(Boolean);
  requireValue(staging.MONGO_URI && staging.MONGO_URI !== env.MONGO_URI && staging.R2_BUCKET === "talkmart-test-media" &&
    staging.R2_STAGING_BUCKET === "talkmart-test-staging" && !stageKeys.some(key => liveKeys.includes(key)) &&
    (staging.JWT_SECRET || "").length >= 32 && (staging.OTP_PEPPER || "").length >= 32 && staging.OTP_PEPPER !== env.OTP_PEPPER, "PRODUCTION_STAGING_NOT_SEPARATE");
  const endpoint = new URL(env.R2_ENDPOINT), publicUrl = new URL(env.R2_PUBLIC_URL);
  requireValue(endpoint.protocol === "https:" && endpoint.hostname.endsWith(".r2.cloudflarestorage.com") && !endpoint.username && !endpoint.password &&
    publicUrl.protocol === "https:" && !publicUrl.username && !publicUrl.password && !publicUrl.search && !publicUrl.hash, "UNEXPECTED_PRODUCTION_R2_ENDPOINT");
}
export function deploymentProcesses(processes) {
  return ["talkmart-api", "talkmart-worker", "talkmart-api-test", "talkmart-worker-test"].map(name => {
    const rows = processes.filter(row => row.name === name), staging = name.endsWith("-test"), worker = name.includes("worker");
    const cwd = staging ? STAGING : LIVE, script = cwd + (staging ? `/scripts/staging/${worker ? "worker" : "api"}.js` : `/src/${worker ? "worker" : "index"}.js`);
    requireValue(rows.length === 1, "UNEXPECTED_PROCESS_COUNT");
    const row = rows[0], env = row.pm2_env || {};
    requireValue(row.pid > 0 && Number.isFinite(env.pm_uptime) && env.status === "online" && env.pm_cwd === cwd && env.pm_exec_path === script, "UNEXPECTED_PRODUCTION_OR_TEST_PROCESS");
    return { name, pid: row.pid, uptime: env.pm_uptime, cwd, script };
  });
}
export function unchangedDeploymentProcesses(before, after) {
  requireValue(before.length === 4 && after.length === 4 && before.every(row => {
    const match = after.find(item => item.name === row.name);
    return match && match.pid === row.pid && match.uptime === row.uptime && match.cwd === row.cwd && match.script === row.script;
  }), "LIVE_OR_TEST_PROCESS_CHANGED");
}
export function safePrivateExpiration(rules) {
  return rules.every(rule => {
    if (rule.Status !== "Enabled" || !rule.Expiration) return true;
    const prefix = rule.Filter?.And?.Prefix ?? rule.Filter?.Prefix ?? rule.Prefix ?? "";
    return !("talkmart/private/".startsWith(prefix) || prefix.startsWith("talkmart/private/"));
  });
}
export function ownedCanaryObjects(id) {
  requireValue(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id), "INVALID_CANARY_ID");
  return [
    { Bucket: "talkmart-staging", Key: `talkmart/private/deployment-checks/${id}.txt` },
    { Bucket: "talkmart", Key: `talkmart/videos/deployment-checks/${id}.txt` },
    { Bucket: "talkmart-staging", Key: `talkmart/private/deployment-checks/${id}-restored.txt` },
    { Bucket: "talkmart-staging", Key: `talkmart/staging/deployment-checks/${id}.mp4` },
  ];
}
export function isolatedCommands(parent) {
  const allowed = ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "SYSTEMROOT", "COMSPEC"];
  return { ...Object.fromEntries(allowed.filter(key => parent[key] !== undefined).map(key => [key, parent[key]])),
    DOTENV_CONFIG_PATH: CANDIDATE + "/tmp/nonexistent-production-preflight.env", NODE_ENV: "test", REDIS_DISABLED: "true" };
}

async function verifyStorage(require, env, report, persist, ensure) {
  const sdk = require("@aws-sdk/client-s3"), { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
  const client = new sdk.S3Client({ region: "auto", endpoint: env.R2_ENDPOINT, requestChecksumCalculation: "WHEN_REQUIRED", maxAttempts: 1,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY } });
  const id = crypto.randomUUID(), objects = ownedCanaryObjects(id), [privateObject, publicObject, restoredObject, multipartObject] = objects;
  let cleaning = false;
  const send = command => { if (!cleaning) ensure(); return client.send(command, { abortSignal: AbortSignal.timeout(20000) }); };
  let uploadId;
  const noObject = error => ["NotFound", "NoSuchKey"].includes(error.name) || error.$metadata?.httpStatusCode === 404;
  const noUpload = error => error.name === "NoSuchUpload" || error.Code === "NoSuchUpload";
  report.storage = { ownedCanaryObjects: objects, checks: {}, privateLifecycle: "pending", privatePublicSettings: "dashboard_required" }; persist();
  const checks = report.storage.checks;
  try {
    try {
      const lifecycle = await send(new sdk.GetBucketLifecycleConfigurationCommand({ Bucket: "talkmart-staging" }));
      requireValue(safePrivateExpiration(lifecycle.Rules || []), "PRIVATE_MEDIA_EXPIRATION_UNSAFE"); report.storage.privateLifecycle = "api_safe";
    } catch (error) {
      if (error.name === "NoSuchLifecycleConfiguration") report.storage.privateLifecycle = "api_safe";
      else if (error.name === "AccessDenied" || error.code === "AccessDenied") report.storage.privateLifecycle = "dashboard_required";
      else throw error;
    }
    const marker = Buffer.from("talkmart-production-preflight-" + id);
    await send(new sdk.PutObjectCommand({ ...privateObject, Body: marker, ContentType: "text/plain", CacheControl: "private, no-store" }));
    const signed = await getSignedUrl(client, new sdk.GetObjectCommand({ ...privateObject, ResponseCacheControl: "private, no-store" }), { expiresIn: 600 });
    assert.equal(new URL(signed).searchParams.get("X-Amz-Expires"), "600");
    const privateResponse = await fetch(signed, { redirect: "manual", signal: AbortSignal.timeout(20000) });
    assert.equal(privateResponse.status, 200); assert.match(privateResponse.headers.get("cache-control"), /no-store/);
    assert.deepEqual(Buffer.from(await privateResponse.arrayBuffer()), marker);
    const ranged = await fetch(signed, { headers: { Range: "bytes=0-7" }, redirect: "manual", signal: AbortSignal.timeout(20000) });
    assert.equal(ranged.status, 206); assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), marker.subarray(0, 8)); checks.privatePreviewAndRange = true;
    const copy = (source, target, cache) => send(new sdk.CopyObjectCommand({ ...target, CopySource: [source.Bucket, ...source.Key.split("/")].map(encodeURIComponent).join("/"),
      ContentType: "text/plain", MetadataDirective: "REPLACE", CacheControl: cache }));
    await copy(privateObject, publicObject, "public, max-age=60, must-revalidate");
    const publicResponse = await fetch(env.R2_PUBLIC_URL.replace(/\/+$/, "") + "/" + publicObject.Key + "?deployment-check=" + id,
      { redirect: "manual", signal: AbortSignal.timeout(20000) });
    assert.equal(publicResponse.status, 200); assert.match(publicResponse.headers.get("cache-control"), /max-age=60(?:\D|$)/);
    assert.deepEqual(Buffer.from(await publicResponse.arrayBuffer()), marker);
    await copy(publicObject, restoredObject, "private, no-store");
    const restored = await send(new sdk.GetObjectCommand(restoredObject)); assert.deepEqual(Buffer.from(await restored.Body.transformToByteArray()), marker);
    await send(new sdk.DeleteObjectCommand(publicObject));
    await assert.rejects(send(new sdk.HeadObjectCommand(publicObject)), noObject); checks.copyPublicationAndOriginRevocation = true;
    console.log("Canli R2 private preview, Range, public/private copy ve origin-den silme: OK");
    const created = await send(new sdk.CreateMultipartUploadCommand({ ...multipartObject, ContentType: "video/mp4", CacheControl: "private, no-store", Metadata: { "talkmart-preflight": id } }));
    uploadId = created.UploadId; requireValue(Boolean(uploadId), "MULTIPART_ID_MISSING");
    const first = Buffer.alloc(8 * 1024 * 1024, 71), tail = Buffer.from(id);
    const sign = (number, bytes, seconds = 600) => getSignedUrl(client, new sdk.UploadPartCommand({ ...multipartObject, UploadId: uploadId, PartNumber: number, ContentLength: bytes }), { expiresIn: seconds });
    const put = (url, bytes) => fetch(url, { method: "PUT", headers: { "Content-Length": String(bytes.length) }, body: bytes, redirect: "manual", signal: AbortSignal.timeout(30000) });
    const firstUrl = await sign(1, first.length); assert.equal(new URL(firstUrl).searchParams.get("X-Amz-SignedHeaders"), "content-length;host");
    const wrong = await put(firstUrl, Buffer.from("wrong")); assert.ok([400, 403].includes(wrong.status)); await wrong.arrayBuffer();
    assert.equal((await send(new sdk.ListPartsCommand({ ...multipartObject, UploadId: uploadId }))).Parts?.length || 0, 0); checks.signedLengthRejected = true;
    const expiredUrl = await sign(2, tail.length, 1); await new Promise(resolve => setTimeout(resolve, 2100));
    const expired = await put(expiredUrl, tail); assert.equal(expired.status, 403); await expired.arrayBuffer(); checks.expiredPartRejected = true;
    for (const [url, body] of [[firstUrl, first], [await sign(2, tail.length), tail]]) { const response = await put(url, body); assert.equal(response.status, 200); await response.arrayBuffer(); }
    const listed = await send(new sdk.ListPartsCommand({ ...multipartObject, UploadId: uploadId }));
    assert.equal(listed.IsTruncated || false, false); const parts = listed.Parts.sort((a, b) => a.PartNumber - b.PartNumber);
    assert.deepEqual(parts.map(part => part.Size), [first.length, tail.length]);
    await send(new sdk.CompleteMultipartUploadCommand({ ...multipartObject, UploadId: uploadId, MultipartUpload: { Parts: parts.map(part => ({ PartNumber: part.PartNumber, ETag: part.ETag })) } }));
    const head = await send(new sdk.HeadObjectCommand(multipartObject)); assert.equal(head.ContentLength, first.length + tail.length);
    assert.equal(head.Metadata?.["talkmart-preflight"], id); assert.match(head.CacheControl, /no-store/);
    const replay = await put(firstUrl, first); assert.ok([400, 404].includes(replay.status)); assert.match(await replay.text(), /NoSuchUpload/); checks.completedPartImmutable = true;
    const downloaded = await send(new sdk.GetObjectCommand(multipartObject)), hash = crypto.createHash("sha256"); let bytes = 0;
    for await (const chunk of downloaded.Body) { bytes += chunk.length; assert.ok(bytes <= head.ContentLength); hash.update(chunk); }
    assert.equal(bytes, head.ContentLength); assert.equal(hash.digest("hex"), sha(Buffer.concat([first, tail]))); checks.multipartMetadataAndHash = true;
    console.log("Canli R2 direct multipart, imzali olcu, expiry, complete-den sonra deyismezlik ve hash: OK");
  } finally {
    cleaning = true;
    try {
      const pending = await send(new sdk.ListMultipartUploadsCommand({ Bucket: multipartObject.Bucket, Prefix: multipartObject.Key, MaxUploads: 100 }));
      assert.equal(pending.IsTruncated || false, false);
      for (const upload of pending.Uploads || []) if (upload.Key === multipartObject.Key) {
        try { await send(new sdk.AbortMultipartUploadCommand({ ...multipartObject, UploadId: upload.UploadId })); } catch (error) { if (!noUpload(error)) throw error; }
      }
      for (const object of objects) { await send(new sdk.DeleteObjectCommand(object)); await assert.rejects(send(new sdk.HeadObjectCommand(object)), noObject); }
      checks.ownedCanariesRemoved = true; console.log("Yalniz bu yoxlamanin R2 obyektleri ve multipart hisseleri silindi: OK");
    } finally { try { persist(); } finally { client.destroy(); } }
  }
}

async function preflight(prepare) {
  let directory, mongoose, before, dbBefore, report, transport, lockFd;
  let cancelled = false;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => { cancelled = true; });
  const ensure = () => requireValue(!cancelled, "PRODUCTION_PREFLIGHT_INTERRUPTED");
  let stage = "scope";
  const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 15000 });
  const rawProcesses = () => JSON.parse(execFileSync("pm2", ["jlist"], { encoding: "utf8", timeout: 15000 }));
  const processes = () => deploymentProcesses(rawProcesses());
  const unusedCandidate = () => requireValue(!fs.existsSync(CANDIDATE + "/.env") && !rawProcesses().some(row =>
    row.pm2_env?.pm_cwd === CANDIDATE || row.pm2_env?.pm_exec_path?.startsWith(CANDIDATE + "/")), "CANDIDATE_ALREADY_CONFIGURED_OR_RUNNING");
  const persist = () => {
    if (!directory || !report) return;
    report.phase = stage; const temporary = path.join(directory, "preflight.next.json");
    fs.writeFileSync(temporary, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 }); fs.renameSync(temporary, path.join(directory, "preflight.json"));
  };
  const fingerprint = async db => {
    const names = (await db.listCollections({ type: "collection" }, { nameOnly: true }).toArray()).map(item => item.name).filter(name => !name.startsWith("system.")).sort();
    const shape = []; for (const name of names) shape.push({ name, indexes: (await db.collection(name).indexes()).sort((a, b) => a.name.localeCompare(b.name)) });
    return sha(JSON.stringify(shape));
  };
  const health = async url => { const response = await fetch(url, { signal: AbortSignal.timeout(15000) }); assert.equal(response.status, 200); assert.equal((await response.json()).status, "ok"); };
  try {
    requireValue(process.platform === "linux" && fs.realpathSync(fileURLToPath(import.meta.url)) === "/root/talkmart-performance-preflight.mjs" && /^[a-f0-9]{64}$/.test(MANIFEST_SHA256), "PACKAGED_PRODUCTION_PREFLIGHT_REQUIRED");
    lockFd = fs.openSync("/root/talkmart-performance-preflight.lock", fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
    requireValue(fs.fstatSync(lockFd).isFile(), "INVALID_PRODUCTION_PREFLIGHT_LOCK");
    try { execFileSync("flock", ["-n", "3"], { stdio: ["ignore", "ignore", "ignore", lockFd] }); }
    catch { throw new Error("PRODUCTION_PREFLIGHT_ALREADY_RUNNING_OR_NO_FLOCK"); }
    requireValue(fs.realpathSync(LIVE) === LIVE && fileSha("/root/talkmart-performance-live.json") === MANIFEST_SHA256, "PRODUCTION_PACKAGE_SCOPE_MISMATCH");
    const spec = validatePerformanceManifest(JSON.parse(fs.readFileSync("/root/talkmart-performance-live.json", "utf8")));
    requireValue(fileSha("/root/talkmart-performance-live.bundle") === spec.bundleSha256, "PRODUCTION_BUNDLE_CHECKSUM_MISMATCH");
    requireValue(git(LIVE, ["rev-parse", "HEAD"]).trim() === BASE && !git(LIVE, ["status", "--porcelain", "--untracked-files=no"]).trim(), "LIVE_CODE_CHANGED");
    before = processes();
    requireValue(!git(STAGING, ["status", "--porcelain", "--untracked-files=no"]).trim() &&
      git(STAGING, ["rev-parse", "HEAD:src"]).trim() === spec.runtimeSrcTree &&
      sha(execFileSync("git", ["show", "HEAD:package-lock.json"], { cwd: STAGING })) === spec.packageLockSha256, "STAGING_RUNTIME_DIFFERS_FROM_RELEASE");
    fs.mkdirSync("/root/talkmart-deployments", { recursive: true, mode: 0o700 });
    directory = fs.mkdtempSync("/root/talkmart-deployments/performance-preflight-20261110-"); fs.chmodSync(directory, 0o700);
    report = { kind: "talkmart-production-performance-preflight", startedAt: new Date().toISOString(), releaseCommit: spec.releaseCommit, baseCommit: BASE, processesBefore: before, passed: false, applicationChanges: false };
    persist(); console.log("Canli ve test proseslerinin yollari/versiyasi: OK");
    const run = (command, args, log, cwd = CANDIDATE, timeout = 300000) => {
      ensure(); unusedCandidate();
      const fd = fs.openSync(path.join(directory, log), "a", 0o600);
      try { execFileSync(command, args, { cwd, timeout, env: isolatedCommands(process.env), stdio: ["ignore", fd, fd] }); } finally { fs.closeSync(fd); }
      unchangedDeploymentProcesses(before, processes());
    };
    stage = "prepare_candidate"; persist();
    if (!fs.existsSync(CANDIDATE)) {
      requireValue(prepare, "PREPARE_CANDIDATE_FIRST");
      run("git", ["bundle", "verify", "/root/talkmart-performance-live.bundle"], "bundle.log", LIVE);
      run("git", ["clone", "--branch", "codex/performance-baseline", "/root/talkmart-performance-live.bundle", CANDIDATE], "clone.log", "/var/www");
    }
    requireValue(fs.realpathSync(CANDIDATE) === CANDIDATE && git(CANDIDATE, ["rev-parse", "HEAD"]).trim() === spec.releaseCommit && !git(CANDIDATE, ["status", "--porcelain", "--untracked-files=no"]).trim(), "CANDIDATE_CODE_OR_PATH_MISMATCH");
    requireValue(git(CANDIDATE, ["rev-parse", "HEAD:src"]).trim() === spec.runtimeSrcTree, "CANDIDATE_RUNTIME_SOURCE_MISMATCH");
    git(CANDIDATE, ["merge-base", "--is-ancestor", BASE, "HEAD"]);
    requireValue(sha(execFileSync("git", ["show", "HEAD:package-lock.json"], { cwd: CANDIDATE })) === spec.packageLockSha256, "CANDIDATE_DEPENDENCIES_CHANGED");
    if (prepare) {
      run("npm", ["ci", "--include=dev"], "npm-ci.log", CANDIDATE, 600000);
      run("npm", ["run", "lint"], "source-check.log"); run("npm", ["test"], "unit-tests.log");
      run("npm", ["run", "test:integration"], "integration-tests.log", CANDIDATE, 600000);
      fs.mkdirSync(path.join(CANDIDATE, "tmp"), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(CANDIDATE, "tmp/production-candidate-tests.json"), JSON.stringify({ releaseCommit: spec.releaseCommit,
        packageLockSha256: spec.packageLockSha256, finishedAt: new Date().toISOString(), nodeVersion: process.version }) + "\n", { mode: 0o600 });
      report.candidateTestsPassed = true; persist(); console.log("Ayrica buraxilis qovlugu, asılıliqlar ve server testleri: OK");
    } else {
      const proof = JSON.parse(fs.readFileSync(path.join(CANDIDATE, "tmp/production-candidate-tests.json"), "utf8")), age = Date.now() - new Date(proof.finishedAt).getTime();
      requireValue(proof.releaseCommit === spec.releaseCommit && proof.packageLockSha256 === spec.packageLockSha256 && proof.nodeVersion === process.version &&
        Number.isFinite(age) && age >= 0 && age < 86400000, "FRESH_CANDIDATE_TESTS_REQUIRED");
      report.candidateTestsPassed = true; report.candidateTestProof = proof;
    }
    ensure(); unusedCandidate();
    const require = createRequire(path.join(CANDIDATE, "package.json")), { parse } = require("dotenv");
    requireValue(fs.realpathSync(LIVE + "/.env") === LIVE + "/.env", "LIVE_ENV_PATH_CHANGED");
    const envBytes = fs.readFileSync(LIVE + "/.env"), env = parse(envBytes), staging = parse(fs.readFileSync("/var/www/backend-test/.env", "utf8"));
    validateProductionSettings(env, staging); report.envHash = sha(envBytes); report.packageLockSha256 = spec.packageLockSha256;
    mongoose = require("mongoose"); stage = "production_database"; persist();
    await mongoose.connect(env.MONGO_URI, { autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 10000 });
    const db = mongoose.connection.db; requireValue(db.databaseName === "test", "PRODUCTION_DATABASE_MISMATCH");
    const hello = await db.admin().command({ hello: 1 }); requireValue(hello.setName || hello.msg === "isdbgrid", "PRODUCTION_REPLICA_SET_REQUIRED");
    dbBefore = await fingerprint(db);
    const stageConnection = mongoose.createConnection(staging.MONGO_URI, { autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 10000 });
    try { await stageConnection.asPromise(); requireValue(stageConnection.name === "talkmart_staging", "STAGING_DATABASE_NOT_SEPARATE"); }
    finally { await stageConnection.close(); }
    const videos = db.collection("videos"), users = db.collection("users");
    report.database = { name: db.databaseName, users: await users.countDocuments(), videos: await videos.countDocuments(),
      unversionedVideos: await videos.countDocuments({ schemaVersion: { $ne: 2 } }),
      activeJobs: await videos.countDocuments({ processingStatus: { $in: ["uploaded", "queued", "processing", "deleting"] } }),
      deletingAccounts: await users.countDocuments({ accountStatus: "deleting" }),
      activeDirectSessions: await db.collection("uploadsessions").countDocuments({ state: { $in: ["creating", "uploading", "completing", "closing"] } }),
      ineligiblePublicMedia: await videos.countDocuments({ videoUrl: { $type: "string", $ne: "" }, $or: [{ moderationStatus: { $ne: "approved" } }, { visibility: "hidden" }] }) };
    requireValue(report.database.unversionedVideos === 0, "VIDEO_SCHEMA_MIGRATION_REQUIRES_REVIEW");
    requireValue(await users.countDocuments({ role: "admin", emailVerified: true, isBlocked: { $ne: true }, accountStatus: { $ne: "deleting" } }) > 0, "NO_ELIGIBLE_PRODUCTION_ADMIN");
    console.log("Canli baza ve movcud v2 schema:", JSON.stringify(report.database));
    await health("http://127.0.0.1:5000/health"); await health("http://127.0.0.1:5001/health");
    await health("https://api.talkmart.az/health"); await health("https://api.talkmart.az/test-api/health");
    execFileSync("nginx", ["-t"], { stdio: "pipe", timeout: 15000 });
    for (const command of ["mongodump", "mongorestore"]) execFileSync(command, ["--version"], { stdio: "pipe", timeout: 15000 });
    requireValue(execFileSync("systemctl", ["is-active", "pm2-root"], { encoding: "utf8", timeout: 15000 }).trim() === "active", "PM2_SYSTEM_SERVICE_NOT_ACTIVE");
    stage = "production_storage"; persist(); await verifyStorage(require, env, report, persist, ensure);
    stage = "smtp"; persist();
    requireValue(env.SMTP_USER && env.SMTP_PASS, "SMTP_CONFIGURATION_MISSING");
    const port = Number(env.SMTP_PORT || 587), secure = env.SMTP_SECURE === "true" || port === 465;
    transport = require("nodemailer").createTransport({ host: env.SMTP_HOST || "smtp.gmail.com", port, secure, requireTLS: !secure,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000 });
    await transport.verify(); report.smtpVerified = true; console.log("SMTP baglantisi ve giris (mesaj gonderilmedi): OK");
    if (env.REDIS_DISABLED !== "true") {
      const Redis = require("ioredis"); const redis = new Redis({ host: env.REDIS_HOST || "127.0.0.1", port: Number(env.REDIS_PORT || 6379),
        password: env.REDIS_PASSWORD || undefined, lazyConnect: true, retryStrategy: null, connectTimeout: 5000, maxRetriesPerRequest: 0, enableOfflineQueue: false });
      redis.on("error", () => {});
      try { await redis.connect(); assert.equal(await redis.ping(), "PONG"); report.redis = "ping_ok"; } finally { redis.disconnect(); }
    } else report.redis = "disabled_by_existing_configuration";
    requireValue(fileSha(LIVE + "/.env") === report.envHash && git(LIVE, ["rev-parse", "HEAD"]).trim() === BASE, "LIVE_CODE_OR_ENV_CHANGED_DURING_PREFLIGHT");
    requireValue(git(CANDIDATE, ["rev-parse", "HEAD"]).trim() === spec.releaseCommit && !git(CANDIDATE, ["status", "--porcelain", "--untracked-files=no"]).trim(), "CANDIDATE_CODE_CHANGED_DURING_PREFLIGHT");
    ensure();
    report.prepared = true; report.privateDashboardRequired = true;
    console.log("Ilkin yoxlama hazirdir. Canli talkmart-staging bucket panel ayarlari ayrica yoxlanmalidir.");
  } catch (error) {
    const code = /^[A-Z_]+$/.test(error.message || "") ? error.message : error.code || error.name;
    if (report) report.error = { stage, code };
    console.error("Canli kecid ilkin yoxlamasi [" + stage + "]:", code); process.exitCode = 1;
  } finally {
    transport?.close();
    if (mongoose && dbBefore) {
      try { requireValue(await fingerprint(mongoose.connection.db) === dbBefore, "DATABASE_METADATA_CHANGED"); report.databaseMetadataUnchanged = true; }
      catch { process.exitCode = 1; if (report) report.databaseMetadataUnchanged = false; }
    }
    if (before) {
      try { unchangedDeploymentProcesses(before, processes()); if (report) report.allProcessIdsPreserved = true; console.log("Canli ve test API/worker PID-leri saxlanildi: OK"); }
      catch { process.exitCode = 1; if (report) report.allProcessIdsPreserved = false; }
    }
    if (cancelled) process.exitCode = 1;
    if (report) { report.finishedAt = new Date().toISOString(); report.passed = !process.exitCode && report.prepared === true; persist(); console.log("Ilkin yoxlama hesabatı:", path.join(directory, "preflight.json")); }
    if (mongoose) await mongoose.disconnect();
    if (lockFd !== undefined) fs.closeSync(lockFd);
    if (report?.passed) console.log("Hazir buraxilis yoxlandi. Canli kod/env/baza ve prosesler hele deyisdirilmeyib.");
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({ options: { prepare: { type: "boolean", default: false }, check: { type: "boolean", default: false }, help: { type: "boolean", default: false } } });
  if (values.help || (!values.prepare && !values.check)) console.log("Packaged helper: node /root/talkmart-performance-preflight.mjs --prepare\nPrepares an unused candidate and checks production read-only, except owned R2 canaries. Never stops API/worker or changes app env/data. No-argument/help makes no changes.");
  else { requireValue(!(values.prepare && values.check), "CHOOSE_PREPARE_OR_CHECK"); await preflight(values.prepare); }
}
