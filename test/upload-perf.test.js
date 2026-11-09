import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { uploadMatrix } from "../scripts/perf/upload-options.js";
import { uploadObjectName, createUploadStorage } from "../scripts/perf/upload-storage.js";
import { isolatedEnvironment } from "../scripts/perf/common.js";

test("upload matrix is bounded to local 20/35/50 MB and 5/10/25 concurrency", () => {
  assert.deepEqual(uploadMatrix(), { sizes: [20, 35, 50], concurrencies: [5, 10, 25] });
  assert.deepEqual(uploadMatrix("20", "5"), { sizes: [20], concurrencies: [5] });
  for (const [sizes, concurrency] of [["250", "5"], ["-20", "5"], ["20", "100"], ["20", "http://example.com"], ["20,35,50,20", "5"]]) assert.throws(() => uploadMatrix(sizes, concurrency));
});

test("local upload object mapping cannot access production buckets or unrelated keys", () => {
  const key = "talkmart/staging/" + "a".repeat(24) + "/11111111-1111-4111-8111-111111111111.mp4";
  assert.match(uploadObjectName("perf-private", key), /^[a-f0-9]{64}$/);
  for (const [bucket, unsafe] of [["talkmart", key], ["talkmart-test-staging", key], ["perf-private", key.replace("staging/", "private/")],
    ["perf-private", key + "/../outside"], ["perf-private", "C:\\outside"], ["perf-private", "https://example.com"]]) assert.throws(() => uploadObjectName(bucket, unsafe));
});

test("owned disk adapter assembles multipart bytes, rejects incomplete commits and cleans aborted parts", async () => {
  const root = path.resolve("tmp/performance"); await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, "uploads-test-")), runId = "c".repeat(32);
  const env = isolatedEnvironment({ runId, uri: `mongodb://127.0.0.1:32123/talkmart_perf_${runId}`, directory });
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    await fs.writeFile(path.join(directory, "upload-owner.json"), JSON.stringify({ kind: "local-upload-intake", runId }));
    const storage = await createUploadStorage(directory);
    const object = { Bucket: "perf-private", Key: "talkmart/staging/" + "a".repeat(24) + "/11111111-1111-4111-8111-111111111111.mp4" };
    const { UploadId } = await storage.send(new CreateMultipartUploadCommand(object));
    const first = await storage.send(new UploadPartCommand({ ...object, UploadId, PartNumber: 1, Body: Buffer.from("first-") }));
    const second = await storage.send(new UploadPartCommand({ ...object, UploadId, PartNumber: 2, Body: Buffer.from("second") }));
    await assert.rejects(storage.send(new CompleteMultipartUploadCommand({ ...object, UploadId, MultipartUpload: { Parts: [{ PartNumber: 1, ETag: first.ETag }] } })), /PERF_INCOMPLETE_MULTIPART/);
    await storage.send(new CompleteMultipartUploadCommand({ ...object, UploadId, MultipartUpload: { Parts: [{ PartNumber: 1, ETag: first.ETag }, { PartNumber: 2, ETag: second.ETag }] } }));
    assert.equal(await fs.readFile(path.join(directory, "objects", uploadObjectName(object.Bucket, object.Key)), "utf8"), "first-second");
    assert.equal(storage.stats().inFlight, 0); assert.deepEqual(await fs.readdir(path.join(directory, "parts")), []);
    await storage.send(new DeleteObjectCommand(object));
    const abandoned = await storage.send(new CreateMultipartUploadCommand(object));
    await storage.send(new UploadPartCommand({ ...object, UploadId: abandoned.UploadId, PartNumber: 1, Body: Buffer.from("abandoned") }));
    await storage.send(new AbortMultipartUploadCommand({ ...object, UploadId: abandoned.UploadId }));
    assert.equal(storage.stats().inFlight, 0); assert.deepEqual(await fs.readdir(path.join(directory, "parts")), []);
    assert.deepEqual(await fs.readdir(path.join(directory, "objects")), []);
    await fs.writeFile(path.join(directory, "upload-owner.json"), JSON.stringify({ kind: "local-upload-intake", runId: "d".repeat(32) }));
    await assert.rejects(createUploadStorage(directory), /PERF_UPLOAD_OWNER_MISMATCH/);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    assert.equal(path.dirname(await fs.realpath(directory)), await fs.realpath(root));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
