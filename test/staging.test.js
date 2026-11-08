import test from "node:test";
import assert from "node:assert/strict";
import { assertStagingSettings, privateExpirationIsSafe, checkPrivateLifecycle } from "../scripts/staging/safety.js";
const live = { MONGO_URI: "mongodb://live.invalid/test", JWT_SECRET: "l".repeat(32), JWT_ACCESS_SECRET: "a".repeat(32), OTP_PEPPER: "o".repeat(32) };
const staging = { NODE_ENV: "production", PORT: "5001", R2_BUCKET: "talkmart-test-media", R2_STAGING_BUCKET: "talkmart-test-staging",
  R2_PUBLIC_URL: "https://pub-4cc7f7a623fc4b02852a0e4f3c5502e4.r2.dev", REDIS_DISABLED: "true", VIDEO_WORKER_CONCURRENCY: "1",
  MONGO_URI: "mongodb://stage.invalid/talkmart_staging", JWT_SECRET: "s".repeat(32), OTP_PEPPER: "p".repeat(32) };
test("staging preflight refuses production buckets, ports, database and signing keys", () => {
  assertStagingSettings(staging, live);
  for (const patch of [{ PORT: "5000" }, { R2_BUCKET: "talkmart" }, { R2_STAGING_BUCKET: "talkmart-staging" },
    { MONGO_URI: live.MONGO_URI }, { JWT_SECRET: live.JWT_SECRET }, { JWT_RESET_SECRET: live.JWT_ACCESS_SECRET }, { OTP_PEPPER: live.OTP_PEPPER }]) {
    assert.throws(() => assertStagingSettings({ ...staging, ...patch }, live));
  }
});
test("lifecycle guard permits original expiry and rejects expiration covering private output", () => {
  assert.equal(privateExpirationIsSafe([]), true);
  assert.equal(privateExpirationIsSafe([{ Status: "Enabled", Expiration: { Days: 1 }, Filter: { Prefix: "talkmart/staging/" } }]), true);
  for (const prefix of ["", "talkmart/", "talkmart/private/", "talkmart/private/videos/"]) {
    assert.equal(privateExpirationIsSafe([{ Status: "Enabled", Expiration: { Days: 1 }, Filter: { And: { Prefix: prefix } } }]), false);
  }
  assert.equal(privateExpirationIsSafe([{ Status: "Disabled", Expiration: { Days: 1 } }, { Status: "Enabled", AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } }]), true);
});
test("object-only credentials leave lifecycle pending until an explicit dashboard confirmation", async () => {
  const denied = async () => { throw Object.assign(new Error("Denied"), { name: "AccessDenied" }); };
  assert.deepEqual(await checkPrivateLifecycle(denied), { verified: false, source: "pending" });
  assert.deepEqual(await checkPrivateLifecycle(denied, { dashboardConfirmed: true }), { verified: true, source: "dashboard" });
  const missing = async () => { throw Object.assign(new Error("Missing"), { name: "NoSuchLifecycleConfiguration" }); };
  assert.deepEqual(await checkPrivateLifecycle(missing), { verified: true, source: "api" });
});
test("dashboard confirmation cannot bypass known unsafe rules or unrelated R2 failures", async () => {
  await assert.rejects(checkPrivateLifecycle(async () => [{ Status: "Enabled", Expiration: { Days: 1 } }], { dashboardConfirmed: true }), /PRIVATE_MEDIA_EXPIRATION_RULE_UNSAFE/);
  for (const name of ["NoSuchBucket", "InvalidAccessKeyId", "TimeoutError"]) {
    const failure = Object.assign(new Error(name), { name });
    await assert.rejects(checkPrivateLifecycle(async () => { throw failure; }, { dashboardConfirmed: true }), error => error === failure);
  }
});
