import crypto from "node:crypto";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { parseArgs } from "node:util";
import { GetBucketLifecycleConfigurationCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { openStaging, checkPrivateLifecycle } from "./safety.js";

const { values } = parseArgs({ options: { "dashboard-settings-confirmed": { type: "boolean", default: false }, help: { type: "boolean", default: false } } });
if (values.help) {
  console.log("node scripts/staging/preflight.js [--dashboard-settings-confirmed]\nUse the confirmation only after checking talkmart-test-staging in the dashboard: public r2.dev/custom-domain access is disabled, and expiration rules do not cover talkmart/private/. Does not change API/worker processes.");
  process.exit(0);
}
let r2, deletion, objects = [], failed = false, lifecycle, stage = "settings";
try {
  await openStaging();
  const db = mongoose.connection.db;
  assert.equal(await db.collection("videos").countDocuments({ processingStatus: { $in: ["uploaded", "queued", "processing"] } }), 0, "TEST_QUEUE_NOT_EMPTY");
  assert.equal(await db.collection("videos").countDocuments({ schemaVersion: { $ne: 2 } }), 0, "TEST_MIGRATION_REQUIRED");
  console.log("Test sazlaması, ayrıca baza və boş emal növbəsi: OK");
  const storage = await import("../../src/services/r2Upload.service.js");
  r2 = (await import("../../src/config/r2.js")).default;
  deletion = storage.deleteFromR2;
  stage = "lifecycle";
  lifecycle = await checkPrivateLifecycle(async () => (await r2.send(new GetBucketLifecycleConfigurationCommand({ Bucket: process.env.R2_STAGING_BUCKET }),
    { abortSignal: AbortSignal.timeout(15000) })).Rules || [], { dashboardConfirmed: values["dashboard-settings-confirmed"] });
  if (lifecycle.source === "api") console.log("Private emal fayllarına avtomatik silinmə qaydası tətbiq olunmur: OK (API)");
  else if (lifecycle.source === "dashboard") console.log("Private bucket ayarlarının paneldə yoxlanması operator tərəfindən təsdiqlənib.");
  else console.log("Lifecycle ayarını oxumağa icazə yoxdur. Panel yoxlaması gözlənilir; fayl sınaqları davam edir.");

  const id = crypto.randomUUID(), marker = Buffer.from("talkmart-private-copy-check-" + id);
  const privateKey = `talkmart/private/checks/${id}.txt`, publicKey = `talkmart/videos/checks/${id}.txt`, restoredKey = `talkmart/private/checks/${id}-restored.txt`;
  objects = [privateKey, publicKey, restoredKey];
  stage = "private_upload_preview";
  await storage.uploadToR2(marker, "talkmart/private/checks", "text/plain", ".txt", privateKey);
  const preview = await storage.privatePreviewUrl(privateKey);
  assert.equal(new URL(preview).searchParams.get("X-Amz-Expires"), "600");
  const response = await fetch(preview, { signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), marker);
  assert.ok(response.headers.get("cache-control")?.includes("no-store"), "PRIVATE_CACHE_HEADER_MISSING");
  const range = await fetch(preview, { headers: { Range: "bytes=0-7" }, signal: AbortSignal.timeout(15000) });
  assert.equal(range.status, 206); assert.deepEqual(Buffer.from(await range.arrayBuffer()), marker.subarray(0, 8));
  console.log("Private imzalı oxuma, 10 dəqiqə müddət, no-store və Range: OK");

  stage = "private_to_public_copy";
  await storage.copyMediaObject(privateKey, publicKey, "text/plain");
  const published = await fetch(storage.publicMediaUrl(publicKey) + "?check=" + id, { signal: AbortSignal.timeout(15000) });
  assert.equal(published.status, 200); assert.deepEqual(Buffer.from(await published.arrayBuffer()), marker);
  assert.ok(/max-age=60(?:\D|$)/.test(published.headers.get("cache-control") || ""), "PUBLIC_CACHE_HEADER_MISMATCH");
  stage = "public_to_private_copy";
  await storage.copyMediaObject(publicKey, restoredKey, "text/plain");
  const restored = await r2.send(new GetObjectCommand({ Bucket: process.env.R2_STAGING_BUCKET, Key: restoredKey }), { abortSignal: AbortSignal.timeout(15000) });
  assert.deepEqual(Buffer.from(await restored.Body.transformToByteArray()), marker);
  stage = "public_origin_delete";
  await deletion(publicKey);
  await assert.rejects(r2.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: publicKey }), { abortSignal: AbortSignal.timeout(15000) }), error => error.name === "NoSuchKey" || error.$metadata?.httpStatusCode === 404);
  console.log("Private → public → private copy, public origin-dən silmə: OK");
} catch (error) {
  failed = true;
  console.error("Test ilkin yoxlaması alınmadı [" + stage + "]:", error.name === "AssertionError" ? error.message : error.code || error.name);
  if (stage === "lifecycle" && error.message === "PRIVATE_MEDIA_EXPIRATION_RULE_UNSAFE") console.error("Lifecycle qaydası private emal fayllarını silə bilər; keçid dayandırıldı.");
} finally {
  for (const key of objects) {
    try { await deletion(key); }
    catch { failed = true; console.error("Yoxlama faylının təmizlənməsi alınmadı:", key); }
  }
  r2?.destroy(); await mongoose.disconnect();
  if (failed) process.exitCode = 1;
  else if (!values["dashboard-settings-confirmed"] || !lifecycle?.verified) {
    console.log("Fayl sınaqları və test fayllarının silinməsi: OK. PANEL_TESDIQI_GOZLENILIR");
    console.log("talkmart-test-staging panelində public r2.dev/custom-domain çıxışını və lifecycle expiration qaydalarını yoxlamadan keçid etmə.");
    process.exitCode = 2;
  } else console.log("İlkin yoxlama tamamlandı: OK. Test API/worker hələ dəyişdirilməyib.");
}
