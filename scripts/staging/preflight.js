import crypto from "node:crypto";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { GetBucketLifecycleConfigurationCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { openStaging, privateExpirationIsSafe } from "./safety.js";

let r2, deletion, objects = [], failed = false;
try {
  await openStaging();
  const db = mongoose.connection.db;
  assert.equal(await db.collection("videos").countDocuments({ processingStatus: { $in: ["uploaded", "queued", "processing"] } }), 0, "TEST_QUEUE_NOT_EMPTY");
  assert.equal(await db.collection("videos").countDocuments({ schemaVersion: { $ne: 2 } }), 0, "TEST_MIGRATION_REQUIRED");
  console.log("Test sazlaması, ayrıca baza və boş emal növbəsi: OK");
  const storage = await import("../../src/services/r2Upload.service.js");
  r2 = (await import("../../src/config/r2.js")).default;
  deletion = storage.deleteFromR2;
  let rules = [];
  try { rules = (await r2.send(new GetBucketLifecycleConfigurationCommand({ Bucket: process.env.R2_STAGING_BUCKET }), { abortSignal: AbortSignal.timeout(15000) })).Rules || []; }
  catch (error) { if (error.name !== "NoSuchLifecycleConfiguration") throw error; }
  assert.ok(privateExpirationIsSafe(rules), "PRIVATE_MEDIA_EXPIRATION_RULE_UNSAFE");
  console.log("Private emal fayllarına avtomatik silinmə qaydası tətbiq olunmur: OK");

  const id = crypto.randomUUID(), marker = Buffer.from("talkmart-private-copy-check-" + id);
  const privateKey = `talkmart/private/checks/${id}.txt`, publicKey = `talkmart/videos/checks/${id}.txt`, restoredKey = `talkmart/private/checks/${id}-restored.txt`;
  objects = [privateKey, publicKey, restoredKey];
  await storage.uploadToR2(marker, "talkmart/private/checks", "text/plain", ".txt", privateKey);
  const preview = await storage.privatePreviewUrl(privateKey);
  assert.equal(new URL(preview).searchParams.get("X-Amz-Expires"), "600");
  const response = await fetch(preview, { signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), marker);
  assert.ok(response.headers.get("cache-control")?.includes("no-store"), "PRIVATE_CACHE_HEADER_MISSING");
  const range = await fetch(preview, { headers: { Range: "bytes=0-7" }, signal: AbortSignal.timeout(15000) });
  assert.equal(range.status, 206); assert.deepEqual(Buffer.from(await range.arrayBuffer()), marker.subarray(0, 8));
  console.log("Private imzalı oxuma, 10 dəqiqə müddət, no-store və Range: OK");

  await storage.copyMediaObject(privateKey, publicKey, "text/plain");
  const published = await fetch(storage.publicMediaUrl(publicKey) + "?check=" + id, { signal: AbortSignal.timeout(15000) });
  assert.equal(published.status, 200); assert.deepEqual(Buffer.from(await published.arrayBuffer()), marker);
  assert.ok(/max-age=60(?:\D|$)/.test(published.headers.get("cache-control") || ""), "PUBLIC_CACHE_HEADER_MISMATCH");
  await storage.copyMediaObject(publicKey, restoredKey, "text/plain");
  const restored = await r2.send(new GetObjectCommand({ Bucket: process.env.R2_STAGING_BUCKET, Key: restoredKey }), { abortSignal: AbortSignal.timeout(15000) });
  assert.deepEqual(Buffer.from(await restored.Body.transformToByteArray()), marker);
  await deletion(publicKey);
  await assert.rejects(r2.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: publicKey }), { abortSignal: AbortSignal.timeout(15000) }), error => error.name === "NoSuchKey" || error.$metadata?.httpStatusCode === 404);
  console.log("Private → public → private copy, public origin-dən silmə: OK");
  console.log("İlkin yoxlama tamamlandı. Test API/worker hələ dəyişdirilməyib.");
  console.log("Paneldə ayrıca yoxlanmalıdır: private bucket üçün r2.dev/custom-domain public access bağlıdır.");
} catch (error) {
  failed = true;
  console.error("Test ilkin yoxlaması alınmadı:", error.name === "AssertionError" ? error.message : error.code || error.name);
} finally {
  for (const key of objects) {
    try { await deletion(key); }
    catch { failed = true; console.error("Yoxlama faylının təmizlənməsi alınmadı:", key); }
  }
  r2?.destroy(); await mongoose.disconnect();
  if (failed) process.exitCode = 1;
}
