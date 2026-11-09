import test from "node:test";
import assert from "node:assert/strict";
import { parse } from "dotenv";
import { validateDirectManifest, directFlagText, directEnvUnchanged, directRollbackAllowed } from "../scripts/staging/direct-activate.js";
const base = "ffc1c33b193f9a6b31a8457cfab8482ffb8e75cb";
const spec = { kind: "talkmart-direct-staging-release", baseCommit: base, releaseCommit: "a".repeat(40), bundleSha256: "b".repeat(64),
  packageLockSha256: "c".repeat(64), preflightScriptSha256: "d".repeat(64), preflightReport: "tmp/direct-r2-preflight-11111111-1111-4111-8111-111111111111.json" };
test("direct release manifest pins the known staging base and refuses external preflight paths", () => {
  assert.equal(validateDirectManifest(spec), spec);
  for (const fields of [{ baseCommit: "584f1c8" }, { releaseCommit: base }, { bundleSha256: "wrong" }, { packageLockSha256: "wrong" },
    { preflightReport: "/root/elsewhere.json" }, { preflightReport: "tmp/../production.json" }, { preflightReport: "https://example.com/check.json" }]) assert.throws(() => validateDirectManifest({ ...spec, ...fields }));
});
test("direct flag updates preserve quoted secrets, CRLF, multiline values and all other settings", () => {
  const text = 'JWT_SECRET="literal$token#value"\r\nMULTILINE="first\nsecond"\r\nPORT=5001\r\nDIRECT_UPLOAD_ENABLED=false';
  const before = parse(text), enabled = parse(directFlagText(text, true)), disabled = parse(directFlagText(directFlagText(text, true), false));
  assert.equal(enabled.DIRECT_UPLOAD_ENABLED, "true"); assert.equal(disabled.DIRECT_UPLOAD_ENABLED, "false");
  assert.equal(directEnvUnchanged(enabled, before), true); assert.equal(directEnvUnchanged(disabled, before), true);
  assert.equal(directEnvUnchanged({ ...enabled, JWT_SECRET: "changed" }, before), false);
  assert.equal(directEnvUnchanged({ ...enabled, EXTRA_SETTING: "new" }, before), false);
});
test("automatic old-code recovery is refused once direct admission or any session is possible", () => {
  const state = { activationMayHaveAdmitted: false, sessions: 0, currentCommit: spec.releaseCommit, releaseCommit: spec.releaseCommit, trackedChanges: false, envUnchanged: true };
  assert.equal(directRollbackAllowed(state), true); assert.equal(directRollbackAllowed({ ...state, currentCommit: base }), true);
  for (const fields of [{ activationMayHaveAdmitted: true }, { activationMayHaveAdmitted: undefined }, { sessions: 1 }, { sessions: undefined },
    { currentCommit: "e".repeat(40) }, { trackedChanges: true }, { trackedChanges: undefined }, { envUnchanged: false }, { releaseCommit: undefined, currentCommit: undefined }]) assert.equal(directRollbackAllowed({ ...state, ...fields }), false);
});
test("an unrelated operator env edit cannot be hidden by the admission flag", () => {
  assert.equal(directEnvUnchanged({ A: "1", B: "2", DIRECT_UPLOAD_ENABLED: "true" }, { B: "2", A: "1" }), true);
  assert.equal(directEnvUnchanged({ A: "1" }, { A: "1", REMOVED: "secret" }), false);
  assert.throws(() => directFlagText("A=1", "true"));
});
