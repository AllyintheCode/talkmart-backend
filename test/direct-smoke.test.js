import test from "node:test";
import assert from "node:assert/strict";
import { validateSmokePart } from "../scripts/staging/direct-smoke.js";
const endpoint = "https://account.r2.cloudflarestorage.com", bucket = "talkmart-test-staging";
const session = { sourceKey: "talkmart/staging/provider/test.mp4", storageUploadId: "owned-upload" };
const url = new URL(`${endpoint}/${bucket}/${session.sourceKey}`);
url.searchParams.set("uploadId", session.storageUploadId); url.searchParams.set("partNumber", "1"); url.searchParams.set("X-Amz-SignedHeaders", "content-length;host");
const part = { partNumber: 1, offset: 0, bytes: 100, method: "PUT", uploadUrl: url.href, headers: { "Content-Length": "100" } };
test("direct smoke sends only the specified part bytes to the owned R2 object", () => {
  assert.equal(validateSmokePart(part, 100, endpoint, bucket, session), part);
  const virtual = new URL(url); virtual.hostname = `${bucket}.${virtual.hostname}`; virtual.pathname = "/" + session.sourceKey;
  assert.doesNotThrow(() => validateSmokePart({ ...part, uploadUrl: virtual.href }, 100, endpoint, bucket, session));
  for (const fields of [{ offset: 1 }, { bytes: 99 }, { method: "POST" }, { headers: { "Content-Length": "100", Authorization: "do-not-send" } }]) assert.throws(() => validateSmokePart({ ...part, ...fields }, 100, endpoint, bucket, session));
});
test("direct smoke refuses alternate hosts, object keys and upload capabilities", () => {
  for (const change of [u => { u.hostname = "outside.invalid"; }, u => { u.protocol = "http:"; }, u => { u.pathname = "/another-bucket/secret"; },
    u => { u.searchParams.set("uploadId", "other-upload"); }, u => { u.searchParams.set("partNumber", "2"); }, u => { u.username = "user"; }]) {
    const altered = new URL(url); change(altered); assert.throws(() => validateSmokePart({ ...part, uploadUrl: altered.href }, 100, endpoint, bucket, session));
  }
});
