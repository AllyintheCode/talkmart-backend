import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { once } from "node:events";
import { execFileSync } from "node:child_process";

export async function sourceRevision() {
  const digest = crypto.createHash("sha256");
  async function visit(directory) {
    for (const item of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(directory, item.name);
      if (item.isDirectory()) await visit(filename);
      else if (item.name.endsWith(".js")) { digest.update(filename.replaceAll("\\", "/") + "\0"); digest.update(await fs.readFile(filename)); }
    }
  }
  await visit("src");
  return { baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    branch: execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim(), sourceSha256: digest.digest("hex"),
    workingTreeDirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) };
}

export async function stopOwnedChild(child) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit").catch(() => {});
  const timeout = setTimeout(() => child.kill("SIGKILL"), 7000);
  try {
    if (child.connected) child.send({ type: "stop" }, error => { if (error) child.kill(); });
    else child.kill();
    await exited;
  } finally { clearTimeout(timeout); }
}

export function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = p => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null;
  return {
    samples: sorted.length, p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99),
    mean: sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null,
    max: sorted.at(-1) ?? null,
  };
}

export function assertLocalDatabase(uri, runId) {
  const url = new URL(uri);
  if (!/^[a-f0-9]{32}$/.test(runId) || url.protocol !== "mongodb:" ||
      url.hostname !== "127.0.0.1" || !url.port || url.username || url.password ||
      url.pathname !== "/talkmart_perf_" + runId ||
      [...url.searchParams.keys()].some(key => key !== "replicaSet")) {
    throw new Error("PERF_DATABASE_MUST_BE_OWNED_LOCAL_INSTANCE");
  }
  return url.pathname.slice(1);
}

export function assertLocalOrigin(origin) {
  const url = new URL(origin);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" ||
      Number(url.port) < 1024 || [5000, 5001].includes(Number(url.port)) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("PERF_HTTP_TARGET_MUST_BE_PRIVATE_EPHEMERAL_LOOPBACK");
  }
  return url.origin;
}

export function isolatedEnvironment({ runId, uri, userId, directory }) {
  assertLocalDatabase(uri, runId);
  // Keep OS runtime settings, never caller application secrets or Node preload hooks.
  const allowed = /^(path|systemroot|windir|comspec|pathext|temp|tmp|userprofile|appdata|localappdata|homedrive|homepath|programfiles(?:\(x86\))?|programdata|lang|lc_all|tz|number_of_processors|processor_architecture)$/i;
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key))),
    NODE_ENV: "test", REDIS_DISABLED: "true", DOTENV_CONFIG_PATH: path.join(directory, "unused.env"),
    PERF_LOCAL: "1", PERF_RUN_ID: runId, PERF_USER_ID: userId || "", MONGO_URI: uri,
    JWT_SECRET: crypto.randomBytes(48).toString("hex"), JWT_ACCESS_SECRET: "", JWT_RESET_SECRET: "",
    OTP_PEPPER: crypto.randomBytes(48).toString("hex"), TRUST_PROXY: "loopback",
    R2_ENDPOINT: "http://127.0.0.1:1", R2_ACCESS_KEY_ID: "local-performance-only",
    R2_SECRET_ACCESS_KEY: "local-performance-only", R2_BUCKET: "perf-media", R2_STAGING_BUCKET: "perf-private",
    R2_PUBLIC_URL: "https://media.invalid", GEMINI_API_KEY: "", GEMINI_API_KEYS: "",
    SMTP_HOST: "127.0.0.1", SMTP_PORT: "1", SMTP_USER: "", SMTP_PASS: "",
    AWS_EC2_METADATA_DISABLED: "true", VIDEO_WORKER_CONCURRENCY: "1",
  };
}

export function assertIsolatedServices(env) {
  if (env.PERF_LOCAL !== "1" || env.NODE_ENV !== "test" || env.REDIS_DISABLED !== "true" ||
      env.R2_ENDPOINT !== "http://127.0.0.1:1" || env.R2_BUCKET !== "perf-media" ||
      env.R2_STAGING_BUCKET !== "perf-private" || env.SMTP_HOST !== "127.0.0.1" || env.SMTP_PORT !== "1" ||
      env.GEMINI_API_KEY || env.GEMINI_API_KEYS || env.SMTP_USER || env.SMTP_PASS ||
      env.JWT_ACCESS_SECRET || env.JWT_RESET_SECRET) throw new Error("PERF_SERVICES_NOT_ISOLATED");
  assertLocalDatabase(env.MONGO_URI, env.PERF_RUN_ID);
}

export function containsContact(value) {
  return Boolean(value && typeof value === "object" && Object.entries(value).some(([key, item]) =>
    ["phone", "email", "address", "whatsapp"].includes(key.toLowerCase()) || containsContact(item)));
}

export async function reportDirectory(kind) {
  const root = path.resolve("tmp/performance");
  await fs.mkdir(root, { recursive: true });
  return fs.mkdtemp(path.join(root, `${kind}-${new Date().toISOString().replace(/[:.]/g, "-")}-`));
}

export function machine() {
  return { platform: process.platform, architecture: process.arch, node: process.version,
    cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, memoryBytes: os.totalmem() };
}
