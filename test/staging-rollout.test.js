import test from "node:test";
import assert from "node:assert/strict";
import { processSnapshot, assertProductionUnchanged, mediaInventory, assertBackupPath, assertBackupManifest } from "../scripts/staging/rollout-safety.js";

const processes = [
  ["talkmart-api", "/var/www/backend-release-20261106", "src/index.js"],
  ["talkmart-worker", "/var/www/backend-release-20261106", "src/worker.js"],
  ["talkmart-api-test", "/var/www/backend-test", "tmp/start-test-api.mjs"],
  ["talkmart-worker-test", "/var/www/backend-test", "tmp/start-test-worker.mjs"],
].map(([name, cwd, script], index) => ({ name, pid: index + 100, pm2_env: { pm_cwd: cwd, pm_exec_path: cwd + "/" + script, pm_uptime: 123, status: "online" } }));
test("staging rollout rejects mixed production/test paths, duplicate apps and production restarts", () => {
  const before = processSnapshot(processes);
  assertProductionUnchanged(before, processes);
  assert.throws(() => processSnapshot([...processes, processes[2]]));
  const swapped = structuredClone(processes); swapped[2].pm2_env.pm_cwd = processes[0].pm2_env.pm_cwd;
  assert.throws(() => processSnapshot(swapped));
  const restarted = structuredClone(processes); restarted[0].pid++;
  assert.throws(() => assertProductionUnchanged(before, restarted));
});
test("media inventory includes legacy URL-only objects and rejects unsafe storage paths", () => {
  const result = mediaInventory([{ publicId: "talkmart/videos/a.mp4", videoUrl: "https://media.invalid/talkmart/videos/a.mp4", thumbnail: "https://media.invalid/talkmart/thumbnails/a.webp", privateVideoKey: "talkmart/private/videos/b.mp4", mediaKeys: ["talkmart/staging/b.mp4"] }],
    [{ profileImage: "https://other.invalid/portrait.jpg" }, { profileImage: "https://media.invalid/talkmart/images/c.webp" }], "https://media.invalid");
  assert.equal(result.length, 5); assert.ok(result.includes("talkmart/thumbnails/a.webp"));
  for (const key of ["other/key", "talkmart/../secret", "talkmart/./secret", "talkmart/\\secret"]) assert.throws(() => mediaInventory([{ publicId: key }], [], "https://media.invalid"));
});
test("rollback accepts only owned private backups and the staging database and buckets", () => {
  const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", bucket = "talkmart-test-media", key = "talkmart/videos/a.mp4";
  const manifest = { kind: "talkmart-staging-rollback", id, complete: true, database: "talkmart_staging", oldCommit: "a".repeat(40), envHash: "a".repeat(64),
    files: Object.fromEntries(["backend-test.tar.gz", "backend-test.bundle", "mongodb-staging.archive.gz", "settings.env"].map(name => [name, "a".repeat(64)])),
    helperHashes: Object.fromEntries(["start-test-api.mjs", "start-test-worker.mjs", "test-safety.mjs"].map(name => [name, "a".repeat(64)])),
    objects: [{ bucket, key, bytes: 10, backupKey: `talkmart/private/rollout-backups/${id}/${bucket}/${key}` }] };
  assertBackupPath("/root/talkmart-backups/perf-staging-2026-11-09-abc123"); assertBackupManifest(manifest);
  for (const value of ["/root", "/var/www/backend", "/root/talkmart-backups/perf-staging-../elsewhere"]) assert.throws(() => assertBackupPath(value));
  for (const patch of [{ database: "test" }, { complete: false }, { files: {} }, { envHash: "invalid" }, { objects: [{ ...manifest.objects[0], bucket: "talkmart" }] }, { objects: [{ ...manifest.objects[0], backupKey: "talkmart/videos/public-backup" }] }]) assert.throws(() => assertBackupManifest({ ...manifest, ...patch }));
});
