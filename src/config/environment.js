export function validateEnvironment() {
  for (const name of ["MONGO_URI", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_STAGING_BUCKET", "R2_PUBLIC_URL"]) {
    if (!process.env[name]) throw new Error(`Missing configuration: ${name}`);
  }
  for (const name of ["OTP_PEPPER", "JWT_SECRET"]) {
    if ((process.env[name] || "").length < 32) throw new Error(`Configuration requires at least 32 characters: ${name}`);
  }
  if (process.env.R2_STAGING_BUCKET === process.env.R2_BUCKET) throw new Error("Staging must use a separate private bucket");
  const concurrency = Number(process.env.VIDEO_WORKER_CONCURRENCY || 1);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error("VIDEO_WORKER_CONCURRENCY must be 1-4");
}
