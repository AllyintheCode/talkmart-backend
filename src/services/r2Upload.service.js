import { PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import r2 from "../config/r2.js";
import crypto from "crypto";
import fs from "fs";
import { pipeline } from "stream/promises";

const BUCKET = process.env.R2_BUCKET;
const PUBLIC_URL = process.env.R2_PUBLIC_URL;
const bucketFor = (key) => key.startsWith("talkmart/staging/") ? process.env.R2_STAGING_BUCKET : BUCKET;


export const uploadToR2 = async (buffer, folder, mimetype, ext = "", keyOverride = "") => {
  const uniqueId = crypto.randomUUID();
  const key = keyOverride || `${folder}/${uniqueId}${ext}`;

  await r2.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mimetype,
    }),
    { abortSignal: AbortSignal.timeout(120000) },
  );

  const url = `${PUBLIC_URL}/${key}`;
  return { key, url };
};

export const uploadFileToR2 = async (filePath, folder, mimetype, ext = "", keyOverride = "") => {
  const uniqueId = crypto.randomUUID();
  const key = keyOverride || `${folder}/${uniqueId}${ext}`;
  const stream = fs.createReadStream(filePath);

  const upload = new Upload({
    client: r2,
    params: {
      Bucket: bucketFor(key),
      Key: key,
      Body: stream,
      ContentType: mimetype,
    },
    queueSize: 3,
    partSize: 8 * 1024 * 1024,
    leavePartsOnError: false,
  });

  const timeout = setTimeout(() => { upload.abort(); stream.destroy(new Error("R2_UPLOAD_TIMEOUT")); }, 120000);
  try { await upload.done(); } finally { clearTimeout(timeout); stream.destroy(); }
  const url = key.startsWith("talkmart/staging/") ? "" : `${PUBLIC_URL}/${key}`;
  return { key, url };
};

export const downloadFromR2 = async (key, destPath) => {
  const result = await r2.send(
    new GetObjectCommand({
      Bucket: bucketFor(key),
      Key: key,
    }),
    { abortSignal: AbortSignal.timeout(120000) },
  );
  let bytes = 0;
  const limit = async function* (source) {
    for await (const chunk of source) {
      bytes += chunk.length;
      if (bytes > 250 * 1024 * 1024) throw new Error("MEDIA_SIZE_LIMIT");
      yield chunk;
    }
  };
  await pipeline(result.Body, limit, fs.createWriteStream(destPath), { signal: AbortSignal.timeout(120000) });
  return destPath;
};

export const deleteFromR2 = async (key) => {
  if (!key) return;
  await r2.send(
    new DeleteObjectCommand({
      Bucket: bucketFor(key),
      Key: key,
    }),
    { abortSignal: AbortSignal.timeout(120000) },
  );
};
