import test from "node:test";
import assert from "node:assert/strict";
import { parse } from "dotenv";
import { validateCutoverEvidence, cutoverModulePaths, oldCodeRecoveryAllowed, assertStagingUnchanged, productionProcessArgs, sameProductionEnv, cutoverEnvText, assertEffectiveProductionConfig } from "../scripts/production/performance-cutover.js";
const base = "94cc79d5d57365fcd41aeecb576587e49dcc19b3", release = "a".repeat(40), envHash = "b".repeat(64);

test("cutover requires fresh same-env tests and every real production storage check", () => {
  const spec = { releaseCommit: release, packageLockSha256: "c".repeat(64) }, now = Date.parse("2026-11-10T10:00:00Z");
  const report = { kind: "talkmart-production-performance-preflight", passed: true, prepared: true, candidateTestsPassed: true, applicationChanges: false,
    allProcessIdsPreserved: true, databaseMetadataUnchanged: true, smtpVerified: true, releaseCommit: release, baseCommit: base, envHash,
    packageLockSha256: spec.packageLockSha256, database: { name: "test", unversionedVideos: 0 }, finishedAt: new Date(now - 1000).toISOString(),
    storage: { privateLifecycle: "dashboard_required", checks: Object.fromEntries(["privatePreviewAndRange", "copyPublicationAndOriginRevocation", "signedLengthRejected", "expiredPartRejected", "completedPartImmutable", "multipartMetadataAndHash", "ownedCanariesRemoved"].map(key => [key, true])) } };
  assert.equal(validateCutoverEvidence(report, spec, envHash, now), report);
  for (const patch of [{ passed: false }, { candidateTestsPassed: undefined }, { allProcessIdsPreserved: false }, { databaseMetadataUnchanged: false }, { applicationChanges: true },
    { baseCommit: release }, { envHash: "d".repeat(64) }, { finishedAt: new Date(now - 86401000).toISOString() }, { finishedAt: new Date(now + 61000).toISOString() },
    { database: { name: "talkmart_staging", unversionedVideos: 0 } }, { storage: { ...report.storage, checks: { ...report.storage.checks, ownedCanariesRemoved: false } } }]) {
    assert.throws(() => validateCutoverEvidence({ ...report, ...patch }, spec, envHash, now));
  }
  assert.throws(() => validateCutoverEvidence(report, {}, undefined, now));
});
test("old-code recovery stops being eligible before any new worker restart or admission", () => {
  const state = { newWorkerMayHaveStarted: false, apiMayHaveAdmitted: false, sessions: 0, trackedChanges: false, envUnchanged: true, releaseCommit: release, currentCommit: release };
  assert.equal(oldCodeRecoveryAllowed(state), true); assert.equal(oldCodeRecoveryAllowed({ ...state, currentCommit: base }), true);
  for (const patch of [{ newWorkerMayHaveStarted: true }, { newWorkerMayHaveStarted: undefined }, { apiMayHaveAdmitted: true }, { apiMayHaveAdmitted: undefined }, { sessions: 1 },
    { sessions: undefined }, { trackedChanges: true }, { envUnchanged: false }, { currentCommit: "d".repeat(40) }, { releaseCommit: base }]) assert.equal(oldCodeRecoveryAllowed({ ...state, ...patch }), false);
});
test("cutover process commands permit only the two production stop/restart actions", () => {
  assert.deepEqual(productionProcessArgs("stop", "talkmart-api"), ["stop", "talkmart-api"]);
  assert.deepEqual(productionProcessArgs("restart", "talkmart-worker"), ["restart", "talkmart-worker", "--update-env"]);
  for (const name of ["all", "talkmart-api-test", "talkmart-worker-test", "other", undefined]) assert.throws(() => productionProcessArgs("stop", name));
  for (const action of ["delete", "reload", "kill", "save", undefined]) assert.throws(() => productionProcessArgs(action, "talkmart-api"));
});
test("staging is checked independently while the production processes are intentionally stopped", () => {
  const before = ["talkmart-api-test", "talkmart-worker-test"].map((name, i) => ({ name, pid: 10 + i, uptime: 100, cwd: "/stage", script: "/stage/" + name + ".js" }));
  const raw = before.map(row => ({ name: row.name, pid: row.pid, pm2_env: { pm_uptime: row.uptime, status: "online", pm_cwd: row.cwd, pm_exec_path: row.script } }));
  assert.doesNotThrow(() => assertStagingUnchanged(before, [...raw, { name: "talkmart-api", pid: 0, pm2_env: { status: "stopped" } }]));
  const restarted = structuredClone(raw); restarted[0].pid++; assert.throws(() => assertStagingUnchanged(before, restarted));
  assert.throws(() => assertStagingUnchanged(before, [...raw, raw[0]]));
  assert.throws(() => assertStagingUnchanged(before.slice(1), raw));
});
test("module swaps use unique children of the existing live folder and reject arbitrary paths", () => {
  const id = "11111111-1111-4111-8111-111111111111", paths = cutoverModulePaths(id);
  assert.equal(paths.current, "/var/www/backend-release-20261106/node_modules");
  assert.equal(paths.before, "/var/www/backend-release-20261106/.talkmart-modules-before-" + id);
  assert.equal(paths.next, "/var/www/backend-release-20261106/.talkmart-modules-next-" + id);
  for (const value of ["../../other", "", undefined, "11111111-1111-1111-1111-111111111111"]) assert.throws(() => cutoverModulePaths(value));
});
test("flag changes preserve every existing credential, CRLF and multiline setting", () => {
  const text = 'JWT_SECRET="literal#secret$dollar"\r\nMONGO_URI="mongodb://user:secret@host/test"\r\nMULTI="first\nsecond"\r\nDIRECT_UPLOAD_ENABLED=false';
  const enabled = parse(cutoverEnvText(text, true, parse)), disabled = parse(cutoverEnvText(cutoverEnvText(text, true, parse), false, parse));
  assert.equal(enabled.DIRECT_UPLOAD_ENABLED, "true"); assert.equal(disabled.DIRECT_UPLOAD_ENABLED, "false");
  assert.equal(sameProductionEnv(enabled, parse(text)), true); assert.equal(sameProductionEnv({ ...enabled, JWT_SECRET: "changed" }, parse(text)), false);
  assert.equal(sameProductionEnv({ ...enabled, NEW_SETTING: "operator" }, parse(text)), false);
  assert.throws(() => cutoverEnvText(text, "true", parse));
});
test("effective PM2 signing, OTP and storage values cannot silently drift during restart", () => {
  const config = { JWT_SECRET: "main", OTP_PEPPER: "pepper", MONGO_URI: "live-uri", R2_BUCKET: "talkmart" };
  const rows = ["talkmart-api", "talkmart-worker"].map(name => ({ name, pm2_env: { env: { ...config } } }));
  assert.doesNotThrow(() => assertEffectiveProductionConfig(rows, config));
  assert.doesNotThrow(() => assertEffectiveProductionConfig(rows.map(row => ({ ...row, pm2_env: {} })), config));
  for (const patch of [{ JWT_SECRET: "changed" }, { JWT_ACCESS_SECRET: "different-access" }, { JWT_RESET_SECRET: "different-reset" }, { OTP_PEPPER: "other" }, { MONGO_URI: "stage-uri" }, { R2_BUCKET: "talkmart-test-media" }]) {
    const changed = structuredClone(rows); Object.assign(changed[0].pm2_env, patch); assert.throws(() => assertEffectiveProductionConfig(changed, config));
  }
  assert.throws(() => assertEffectiveProductionConfig(rows.slice(1), config));
});
