import { PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import r2 from "../config/r2.js";
import crypto from "crypto";

const BUCKET = process.env.R2_BUCKET;
const PUBLIC_URL = process.env.R2_PUBLIC_URL; // https://pub-xxx.r2.dev və ya custom domain

/**
 * Faylı R2-yə yükləyir
 * @param {Buffer} buffer - Faylın buffer-i
 * @param {string} folder - Qovluq adı (məs. "videos", "images", "thumbnails")
 * @param {string} mimetype - Faylın MIME tipi
 * @param {string} [ext] - Fayl uzantısı (məs. ".mp4", ".jpg")
 * @returns {{ key: string, url: string }}
 */
export const uploadToR2 = async (buffer, folder, mimetype, ext = "") => {
  const uniqueId = crypto.randomUUID();
  const key = `${folder}/${uniqueId}${ext}`;

  await r2.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mimetype,
    })
  );

  const url = `${PUBLIC_URL}/${key}`;
  return { key, url };
};

/**
 * R2-dən faylı silir
 * @param {string} key - Faylın R2 key-i
 */
export const deleteFromR2 = async (key) => {
  if (!key) return;
  await r2.send(
    new DeleteObjectCommand({
      Bucket: BUCKET,
      Key: key,
    })
  );
};
