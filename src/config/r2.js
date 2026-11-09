import { S3Client } from "@aws-sdk/client-s3";

const options = {
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
};
const r2 = new S3Client(options);
// Direct clients sign a body they do not possess. Do not let the SDK attach a
// checksum for an absent body; the existing multipart upload client is unchanged.
export const directR2 = new S3Client({ ...options, requestChecksumCalculation: "WHEN_REQUIRED", maxAttempts: 1 });

export default r2;
