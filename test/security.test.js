import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { signAccessToken, verifyAccessToken, signPasswordResetToken, verifyPasswordResetToken } from "../src/utils/jwt.js";
import { generateOtpCode, hashOtp, verifyOtpHash } from "../src/utils/otp.js";
import { redact } from "../src/utils/logger.js";
import { parsePagination, explorePaginationSchema } from "../src/utils/pagination.js";
import { parseModerationResult, validateVideoContentAI } from "../src/services/aiModeration.service.js";
import { canPublishVideo } from "../src/services/videoState.service.js";
import { anonymousViewer } from "../src/controllers/engagement.controller.js";
import { videoV2Fields } from "../src/services/videoMigration.service.js";
import { cursorFilter, nextCursor } from "../src/utils/pagination.js";
const id = "507f1f77bcf86cd799439011";

test("JWT types are isolated and signature, issuer, audience, expiry and version are required", () => {
  const access = signAccessToken({ id, sv: 3 });
  assert.equal(verifyAccessToken(access).sv, 3);
  const reset = signPasswordResetToken({ id, jti: crypto.randomUUID() });
  assert.equal(verifyPasswordResetToken(reset).typ, "password_reset");
  assert.throws(() => verifyAccessToken(reset));
  assert.throws(() => verifyPasswordResetToken(access));
  const sign = (payload, options = {}) => jwt.sign(payload, process.env.JWT_SECRET, { issuer: "talkmart", audience: "talkmart-api", expiresIn: "1h", ...options });
  for (const token of [
    jwt.sign({ id }, process.env.JWT_SECRET),
    sign({ id, typ: "access" }),
    sign({ id, sv: 1 }),
    sign({ id, sv: 1, typ: "access" }, { issuer: "other" }),
    sign({ id, sv: 1, typ: "access" }, { audience: "other" }),
    sign({ id, sv: 1, typ: "access" }, { expiresIn: -1 }),
    sign({ id, sv: 1, typ: "access" }, { algorithm: "HS384" }),
    access.slice(0, -3) + "bad",
  ]) assert.throws(() => verifyAccessToken(token));
  assert.throws(() => verifyPasswordResetToken(jwt.sign({ id, typ: "password_reset", jti: "x" }, process.env.JWT_SECRET, { issuer: "wrong", audience: "wrong" })));
});
test("OTP generation and HMAC are purpose and account scoped, with no legacy SHA fallback", () => {
  for (let i = 0; i < 100000; i++) assert.match(generateOtpCode(), /^[1-9]\d{5}$/);
  const hash = hashOtp("register", "USER@example.test", "123456");
  assert.ok(verifyOtpHash("register", "user@example.test", "123456", hash));
  assert.ok(!verifyOtpHash("forgot_password", "user@example.test", "123456", hash));
  assert.ok(!verifyOtpHash("register", "another@example.test", "123456", hash));
  assert.ok(!verifyOtpHash("register", "user@example.test", "123456", "short"));
  assert.ok(!verifyOtpHash("register", "user@example.test", "123456", crypto.createHash("sha256").update("123456").digest("hex")));
});
test("structured logger redacts credentials, authorization, email and OTP in errors", () => {
  const result = JSON.stringify(redact({ nested: { password: "supersecret", authorization: "Bearer test" }, err: new Error(`smtp user@example.test 123456 ${process.env.JWT_SECRET}`) }));
  for (const secret of ["supersecret", "Bearer test", "user@example.test", "123456", process.env.JWT_SECRET]) assert.ok(!result.includes(secret));
  const signed = "https://private.storage.invalid/video.mp4?X-Amz-Credential=private-access&X-Amz-Signature=private-signature";
  assert.equal(redact("preview: " + signed), "preview: [REDACTED_MEDIA_URL]");
});
test("pagination rejects negative, huge, fractional and long search inputs", () => {
  for (const query of [{ page: -1 }, { limit: 999999 }, { limit: 1.2 }, { page: 10000, limit: 50 }, { search: "a".repeat(101) }]) assert.throws(() => parsePagination(query));
  assert.deepEqual(parsePagination({ page: "2", limit: "10" }), { page: 2, limit: 10, search: undefined, skip: 10 });
  assert.throws(() => parsePagination({ limit: 100 }));
  assert.deepEqual(parsePagination({}, {}, explorePaginationSchema), { page: 1, limit: 15, search: undefined, skip: 0 });
  assert.deepEqual(parsePagination({ page: "2", limit: "100" }, { limit: 15 }, explorePaginationSchema), { page: 2, limit: 100, search: undefined, skip: 100 });
  for (const query of [{ limit: 101 }, { limit: 0 }, { limit: 1.2 }, { page: 102, limit: 100 }]) {
    assert.throws(() => parsePagination(query, { limit: 15 }, explorePaginationSchema));
  }
});
test("AI malformed, partial and ambiguous responses never approve", async () => {
  const valid = { serviceProvided: "Cleaning", matchesCategory: true, hasBannedContent: false, confidenceScore: 95, reasoning: "Visible service" };
  assert.equal(parseModerationResult(valid).finalStatus, "approved");
  for (const raw of [{}, null, { ...valid, confidenceScore: 250 }, { ...valid, confidenceScore: "95" }, { ...valid, reasoning: "" }, { ...valid, extra: true }]) assert.equal(parseModerationResult(raw).finalStatus, "review");
  assert.equal(parseModerationResult({ ...valid, serviceProvided: false }).finalStatus, "review");
  assert.equal(parseModerationResult({ ...valid, hasBannedContent: true }).finalStatus, "rejected");
  assert.equal((await validateVideoContentAI({ tempFilePath: "unused" })).finalStatus, "review");
});
test("publishing requires media, readiness, approval, visible state and active owner", () => {
  const video = { processingStatus: "ready", videoUrl: "https://media.invalid/video.mp4", moderationStatus: "approved", status: "inactive", visibility: "public" };
  const owner = { emailVerified: true, isBlocked: false, accountStatus: "active" };
  assert.ok(canPublishVideo(video, owner));
  for (const change of [{ processingStatus: "failed" }, { processingStatus: "processing" }, { videoUrl: "" }, { status: "deleting" }, { moderationStatus: "review" }, { visibility: "hidden" }]) assert.ok(!canPublishVideo({ ...video, ...change }, owner));
  for (const change of [{ isBlocked: true }, { accountStatus: "deleting" }, { emailVerified: false }]) assert.ok(!canPublishVideo(video, { ...owner, ...change }));
});
test("anonymous view sessions are signed, reusable and reject client-forged IDs", () => {
  let cookie;
  const res = { cookie: (key, value) => { cookie = `${key}=${value}`; } };
  const first = anonymousViewer({ headers: {} }, res);
  assert.equal(anonymousViewer({ headers: { cookie } }, res), first);
  assert.notEqual(anonymousViewer({ headers: { cookie: cookie + "tamper" } }, res), first);
});
test("legacy migration fails closed and preserves explicit admin decisions", () => {
  const owner = { emailVerified: true, accountStatus: "active" };
  assert.equal(videoV2Fields({ status: "active", videoUrl: "media" }, owner).status, "inactive");
  assert.equal(videoV2Fields({ processingStatus: "processing", moderationSource: "admin", moderationStatus: "rejected" }, owner).moderationStatus, "rejected");
  assert.equal(videoV2Fields({ processingStatus: "queued" }, owner).processingStatus, "failed");
  assert.equal(videoV2Fields({ processingStatus: "processing", stagingKey: "source" }, owner).processingStatus, "queued");
  assert.equal(videoV2Fields({ status: "active", videoUrl: "media", processingStatus: "ready", moderationStatus: "approved" }, owner).status, "active");
  assert.equal(videoV2Fields({ thumbnail: "https://old-media.invalid/talkmart/thumbnails/old.webp" }, owner).thumbnailPublicId, "talkmart/thumbnails/old.webp");
  assert.equal(videoV2Fields({ thumbnail: "https://external.invalid/unrelated.jpg" }, owner).thumbnailPublicId, "");
});
test("cursor pagination validates its date and identifier", () => {
  const cursor = nextCursor([{ _id: id, createdAt: new Date("2026-10-25T00:00:00Z") }], 1);
  assert.equal(cursorFilter(cursor).$or[1]._id.$lt, id);
  assert.throws(() => cursorFilter("invalid"));
  assert.throws(() => cursorFilter(Buffer.from(JSON.stringify({ id: "bad", at: "yesterday" })).toString("base64url")));
});
