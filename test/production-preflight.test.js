import test from "node:test";
import assert from "node:assert/strict";
import { BASE, LIVE, STAGING, validatePerformanceManifest, validateProductionSettings, deploymentProcesses,
  unchangedDeploymentProcesses, safePrivateExpiration, ownedCanaryObjects, isolatedCommands } from "../scripts/production/performance-preflight.js";

test("production release pins the deployed audit base and content checksums", () => {
  const manifest = { kind: "talkmart-production-performance-release", baseCommit: BASE, releaseCommit: "a".repeat(40), bundleSha256: "b".repeat(64), packageLockSha256: "c".repeat(64), runtimeSrcTree: "d".repeat(40) };
  assert.equal(validatePerformanceManifest(manifest), manifest);
  for (const patch of [{ baseCommit: "584f1c8" }, { baseCommit: "ffc1c33" }, { releaseCommit: BASE }, { bundleSha256: "../file" }, { packageLockSha256: undefined }, { runtimeSrcTree: "wrong" }]) assert.throws(() => validatePerformanceManifest({ ...manifest, ...patch }));
  assert.throws(() => validatePerformanceManifest(null));
});
test("live preflight refuses staging resources, short signing keys and shared identities", () => {
  const live = { NODE_ENV: "production", PORT: "5000", TRUST_PROXY: "loopback", MONGO_URI: "mongodb://live/test", R2_BUCKET: "talkmart", R2_STAGING_BUCKET: "talkmart-staging",
    R2_ENDPOINT: "https://account.r2.cloudflarestorage.com", R2_PUBLIC_URL: "https://live.example.com", R2_ACCESS_KEY_ID: "access", R2_SECRET_ACCESS_KEY: "secret", GEMINI_MODEL: "configured-model",
    JWT_SECRET: "a".repeat(40), OTP_PEPPER: "b".repeat(40) };
  const staging = { MONGO_URI: "mongodb://staging/talkmart_staging", R2_BUCKET: "talkmart-test-media", R2_STAGING_BUCKET: "talkmart-test-staging", JWT_SECRET: "c".repeat(40), OTP_PEPPER: "d".repeat(40) };
  assert.doesNotThrow(() => validateProductionSettings(live, staging));
  for (const patch of [{ PORT: "5001" }, { R2_BUCKET: "talkmart-test-media" }, { R2_STAGING_BUCKET: "talkmart-test-staging" }, { JWT_SECRET: "short" }, { R2_ENDPOINT: "http://outside.invalid" }, { R2_PUBLIC_URL: "https://user:password@example.com" }]) assert.throws(() => validateProductionSettings({ ...live, ...patch }, staging));
  for (const patch of [{ MONGO_URI: live.MONGO_URI }, { JWT_SECRET: live.JWT_SECRET }, { JWT_RESET_SECRET: live.JWT_SECRET }, { OTP_PEPPER: live.OTP_PEPPER }, { JWT_SECRET: undefined }]) assert.throws(() => validateProductionSettings(live, { ...staging, ...patch }));
});
test("preflight requires the four exact running processes and catches a single restart", () => {
  const names = ["talkmart-api", "talkmart-worker", "talkmart-api-test", "talkmart-worker-test"];
  const rows = names.map((name, index) => { const staging = name.endsWith("-test"), worker = name.includes("worker"), cwd = staging ? STAGING : LIVE;
    return { name, pid: 10 + index, pm2_env: { pm_uptime: 100 + index, pm_cwd: cwd, status: "online", pm_exec_path: cwd + (staging ? `/scripts/staging/${worker ? "worker" : "api"}.js` : `/src/${worker ? "worker" : "index"}.js`) } }; });
  const snapshot = deploymentProcesses(rows); assert.doesNotThrow(() => unchangedDeploymentProcesses(snapshot, deploymentProcesses(rows)));
  for (const index of [0, 1, 2, 3]) { const changed = structuredClone(rows); changed[index].pid++; assert.throws(() => unchangedDeploymentProcesses(snapshot, deploymentProcesses(changed))); }
  assert.throws(() => deploymentProcesses(rows.slice(1)));
  assert.throws(() => deploymentProcesses([...rows, rows[0]]));
  const wrong = structuredClone(rows); wrong[0].pm2_env.pm_cwd = STAGING; assert.throws(() => deploymentProcesses(wrong));
});
test("private output lifecycle rejects broad expiry and allows original expiry or incomplete MPU abort", () => {
  assert.equal(safePrivateExpiration([{ Status: "Enabled", AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 } }]), true);
  assert.equal(safePrivateExpiration([{ Status: "Enabled", Filter: { Prefix: "talkmart/staging/" }, Expiration: { Days: 7 } }]), true);
  for (const prefix of ["", "talkmart/", "talkmart/private/", "talkmart/private/videos/"]) assert.equal(safePrivateExpiration([{ Status: "Enabled", Filter: { Prefix: prefix }, Expiration: { Days: 7 } }]), false);
  assert.equal(safePrivateExpiration([{ Status: "Disabled", Expiration: { Days: 1 } }]), true);
});
test("canary cleanup scope contains only four unique run-owned production keys", () => {
  const id = "11111111-1111-4111-8111-111111111111", objects = ownedCanaryObjects(id);
  assert.equal(objects.length, 4); assert.equal(new Set(objects.map(o => o.Bucket + "/" + o.Key)).size, 4);
  for (const item of objects) { assert.ok(["talkmart", "talkmart-staging"].includes(item.Bucket)); assert.ok(item.Key.includes("/deployment-checks/" + id)); }
  for (const value of ["../other", "", undefined, "11111111-1111-1111-1111-111111111111"]) assert.throws(() => ownedCanaryObjects(value));
});
test("candidate install/tests cannot inherit live application secrets or dotenv settings", () => {
  const env = isolatedCommands({ PATH: "/node/bin", HOME: "/root", MONGO_URI: "live", JWT_SECRET: "secret", R2_SECRET_ACCESS_KEY: "secret", NODE_OPTIONS: "--require unexpected", DOTENV_CONFIG_PATH: "live.env" });
  assert.equal(env.PATH, "/node/bin"); assert.equal(env.NODE_ENV, "test"); assert.equal(env.REDIS_DISABLED, "true");
  for (const key of ["MONGO_URI", "JWT_SECRET", "R2_SECRET_ACCESS_KEY", "NODE_OPTIONS"]) assert.equal(key in env, false);
  assert.ok(env.DOTENV_CONFIG_PATH.endsWith("/tmp/nonexistent-production-preflight.env"));
});
