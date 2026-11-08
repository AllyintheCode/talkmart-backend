import path from "node:path";

export const oldDirectory = "/var/www/backend-test";
export const newDirectory = "/var/www/backend-perf-test-20261108";
export const productionDirectory = "/var/www/backend-release-20261106";
export const managedNames = ["talkmart-api-test", "talkmart-worker-test"];
export function processSnapshot(processes, phase = "old", names = ["talkmart-api", "talkmart-worker", ...managedNames]) {
  return names.map(name => {
    const matches = processes.filter(item => item.name === name);
    if (matches.length !== 1) throw new Error("PROCESS_COUNT_" + name);
    const item = matches[0], env = item.pm2_env || {};
    const production = !managedNames.includes(name), worker = name.includes("worker");
    const cwd = production ? productionDirectory : phase === "old" ? oldDirectory : newDirectory;
    const script = production ? `src/${worker ? "worker" : "index"}.js` : phase === "old" ? `tmp/start-test-${worker ? "worker" : "api"}.mjs` : `scripts/staging/${worker ? "worker" : "api"}.js`;
    if (env.pm_cwd !== cwd || env.pm_exec_path !== cwd + "/" + script || env.status !== "online" || !(item.pid > 0)) throw new Error("UNEXPECTED_PROCESS_" + name);
    return { name, pid: item.pid, cwd, script: env.pm_exec_path, uptime: env.pm_uptime };
  });
}
export function assertProductionUnchanged(before, processes) {
  for (const original of before.filter(item => !managedNames.includes(item.name))) {
    const current = processes.filter(item => item.name === original.name);
    if (current.length !== 1 || current[0].pid !== original.pid || current[0].pm2_env?.pm_uptime !== original.uptime || current[0].pm2_env?.status !== "online") throw new Error("PRODUCTION_PROCESS_CHANGED");
  }
}
export function mediaInventory(videos, users, publicBase) {
  const keys = new Set(), base = new URL(publicBase);
  const add = key => {
    if (!key) return;
    if (typeof key !== "string" || !key.startsWith("talkmart/") || key.includes("\\") || key.split("/").some(part => part === ".." || part === ".")) throw new Error("UNEXPECTED_MEDIA_KEY");
    keys.add(key);
  };
  const fromUrl = value => {
    if (!value) return;
    const url = new URL(value), prefix = base.pathname.replace(/\/+$/, "") + "/";
    if (url.origin === base.origin && url.pathname.startsWith(prefix)) add(decodeURIComponent(url.pathname.slice(prefix.length)));
  };
  for (const video of videos) {
    for (const key of [video.publicId, video.thumbnailPublicId, video.stagingKey, video.privateVideoKey, video.privateThumbnailKey, ...(video.mediaKeys || []), ...(video.publicDeletionKeys || [])]) add(key);
    fromUrl(video.videoUrl); fromUrl(video.thumbnail);
  }
  for (const user of users) { add(user.profileImagePublicId); fromUrl(user.profileImage); }
  return [...keys].sort();
}
export function assertBackupPath(directory) {
  if (typeof directory !== "string" || !/^\/root\/talkmart-backups\/perf-staging-[a-zA-Z0-9-]+$/.test(directory) || path.posix.normalize(directory) !== directory) throw new Error("INVALID_STAGING_BACKUP_PATH");
}
export function assertBackupManifest(manifest) {
  if (manifest.kind !== "talkmart-staging-rollback" || !manifest.complete || manifest.database !== "talkmart_staging" || !/^[a-f\d-]{36}$/.test(manifest.id) ||
      !/^[a-f0-9]{40}$/.test(manifest.oldCommit) || !Array.isArray(manifest.objects)) throw new Error("INVALID_STAGING_BACKUP_MANIFEST");
  const requiredFiles = ["backend-test.tar.gz", "backend-test.bundle", "mongodb-staging.archive.gz", "settings.env"];
  const requiredHelpers = ["start-test-api.mjs", "start-test-worker.mjs", "test-safety.mjs"];
  if (!/^[a-f0-9]{64}$/.test(manifest.envHash) || !manifest.files || !manifest.helperHashes ||
      Object.keys(manifest.files).length !== requiredFiles.length || Object.keys(manifest.helperHashes).length !== requiredHelpers.length ||
      requiredFiles.some(name => !/^[a-f0-9]{64}$/.test(manifest.files[name])) || requiredHelpers.some(name => !/^[a-f0-9]{64}$/.test(manifest.helperHashes[name]))) throw new Error("INVALID_STAGING_BACKUP_CHECKSUMS");
  for (const item of manifest.objects) {
    if (!["talkmart-test-media", "talkmart-test-staging"].includes(item.bucket) || typeof item.key !== "string" || !item.key.startsWith("talkmart/") ||
        item.key.includes("\\") || item.key.split("/").some(part => [".", ".."].includes(part)) ||
        item.backupKey !== `talkmart/private/rollout-backups/${manifest.id}/${item.bucket}/${item.key}` ||
        (!item.missing && (!Number.isSafeInteger(item.bytes) || item.bytes < 0))) throw new Error("INVALID_STAGING_BACKUP_OBJECT");
  }
}
