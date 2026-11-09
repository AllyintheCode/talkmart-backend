// Disk-backed test adapter for the real AWS multipart Upload class. No S3 HTTP
// requests are sent. Only the owned run's private staging originals are allowed.
import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { assertIsolatedServices } from "./common.js";

export function uploadObjectName(bucket, key) {
  if (bucket !== "perf-private" || typeof key !== "string" || !/^talkmart\/staging\/[a-f0-9]{24}\/[a-f0-9-]{36}\.mp4$/.test(key)) throw new Error("PERF_UNEXPECTED_UPLOAD_OBJECT");
  return crypto.createHash("sha256").update(bucket + ":" + key).digest("hex");
}

export async function createUploadStorage(directory) {
  assertIsolatedServices(process.env);
  const root = await fs.realpath(directory);
  if (path.dirname(root) !== await fs.realpath("tmp/performance") || !path.basename(root).startsWith("uploads-")) throw new Error("PERF_UPLOAD_DIRECTORY_NOT_OWNED");
  const marker = JSON.parse(await fs.readFile(path.join(root, "upload-owner.json"), "utf8"));
  if (marker.runId !== process.env.PERF_RUN_ID || marker.kind !== "local-upload-intake") throw new Error("PERF_UPLOAD_OWNER_MISMATCH");
  const objects = path.join(root, "objects"), parts = path.join(root, "parts");
  await fs.mkdir(objects, { recursive: true }); await fs.mkdir(parts, { recursive: true });
  if (await fs.realpath(objects) !== objects || await fs.realpath(parts) !== parts) throw new Error("PERF_UPLOAD_STORAGE_SYMLINK");
  const uploads = new Map();
  let stats;
  const reset = () => { stats = { multipartStarted: 0, partsUploaded: 0, completed: 0, puts: 0, deleted: 0 }; };
  reset();
  const objectPath = input => path.join(objects, uploadObjectName(input.Bucket, input.Key));
  const maxBytes = 50 * 1000 * 1000;
  async function write(body, target) {
    let size = 0;
    const source = body instanceof Uint8Array ? [body] : body;
    await pipeline((async function* () {
      for await (const chunk of source) {
        size += chunk.length;
        if (size > maxBytes) throw new Error("PERF_UPLOAD_BODY_TOO_LARGE");
        yield chunk;
      }
    })(), createWriteStream(target, { flags: "wx" }));
    return size;
  }
  const etag = filename => crypto.createHash("sha256").update(filename).digest("hex");
  async function send(command) {
    const input = command.input, name = command.constructor.name, target = objectPath(input);
    if (name === "CreateMultipartUploadCommand") {
      if (uploads.size >= 25) throw new Error("PERF_TOO_MANY_MULTIPART_UPLOADS");
      const id = crypto.randomUUID();
      uploads.set(id, { target, parts: new Map() }); stats.multipartStarted++;
      return { UploadId: id };
    }
    if (name === "PutObjectCommand") {
      await write(input.Body, target); stats.puts++;
      return { ETag: etag(target), $metadata: { httpStatusCode: 200 } };
    }
    if (name === "DeleteObjectCommand") { await fs.rm(target, { force: true }); stats.deleted++; return {}; }
    const upload = uploads.get(input.UploadId);
    if (!upload || upload.target !== target) throw new Error("PERF_MULTIPART_OWNER_MISMATCH");
    if (name === "UploadPartCommand") {
      if (!Number.isInteger(input.PartNumber) || input.PartNumber < 1 || input.PartNumber > 7) throw new Error("PERF_INVALID_PART");
      const filename = path.join(parts, `${input.UploadId}-${input.PartNumber}`);
      await write(input.Body, filename); upload.parts.set(input.PartNumber, filename); stats.partsUploaded++;
      return { ETag: etag(filename) };
    }
    if (name === "CompleteMultipartUploadCommand") {
      const rows = input.MultipartUpload?.Parts || [];
      if (rows.length !== upload.parts.size || !rows.length || rows.some((row, index) => row.PartNumber !== index + 1 || row.ETag !== etag(upload.parts.get(row.PartNumber)))) throw new Error("PERF_INCOMPLETE_MULTIPART");
      await write((async function* () { for (const row of rows) yield* createReadStream(upload.parts.get(row.PartNumber)); })(), target);
      for (const filename of upload.parts.values()) await fs.rm(filename);
      uploads.delete(input.UploadId); stats.completed++;
      return { ETag: etag(target), $metadata: { httpStatusCode: 200 } };
    }
    if (name === "AbortMultipartUploadCommand") {
      for (const filename of upload.parts.values()) await fs.rm(filename, { force: true });
      uploads.delete(input.UploadId); return {};
    }
    throw new Error("PERF_UNEXPECTED_STORAGE_COMMAND");
  }
  return { send, reset, stats: () => ({ ...stats, inFlight: uploads.size }) };
}
