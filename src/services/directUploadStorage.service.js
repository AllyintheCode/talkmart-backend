import { CreateMultipartUploadCommand, UploadPartCommand, ListPartsCommand, CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand, HeadObjectCommand, DeleteObjectCommand, ListMultipartUploadsCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { directR2 } from "../config/r2.js";

export const DIRECT_PART_BYTES = 8 * 1024 * 1024;
export const DIRECT_MAX_BYTES = 250 * 1024 * 1024;
export const directError = (status, code, message = code) => Object.assign(new Error(message), { status, code });
// UploadPart presigning must not bind a checksum computed for an absent body.
// The direct-only client also uses this checksum policy when creating multipart
// uploads; it does not change the legacy Upload class's checksum configuration.
const signer = directR2;
const send = command => directR2.send(command, { abortSignal: AbortSignal.timeout(15000) });
export const missingObject = error => ["NotFound", "NoSuchKey"].includes(error.name) || error.$metadata?.httpStatusCode === 404;
const missingUpload = error => error.name === "NoSuchUpload" || error.code === "NoSuchUpload";
export function directObject(session) {
  const prefix = `talkmart/staging/${session.providerId}/`;
  if (typeof session.sourceKey !== "string" || !session.sourceKey.startsWith(prefix) ||
      !/^[a-f0-9-]{36}\.(mp4|mov|avi|mkv)$/.test(session.sourceKey.slice(prefix.length))) throw directError(500, "INVALID_UPLOAD_STORAGE_SCOPE");
  return { Bucket: process.env.R2_STAGING_BUCKET, Key: session.sourceKey };
}
export const directPartCount = session => Math.ceil(session.declaredBytes / DIRECT_PART_BYTES);
export const directPartSize = (session, number) => Math.min(DIRECT_PART_BYTES, session.declaredBytes - (number - 1) * DIRECT_PART_BYTES);
export async function createDirectMultipart(session) {
  const result = await send(new CreateMultipartUploadCommand({ ...directObject(session), ContentType: session.contentType,
    CacheControl: "private, no-store", Metadata: { "talkmart-session": String(session._id), "talkmart-provider": String(session.providerId) } }));
  if (!result.UploadId || typeof result.UploadId !== "string") throw directError(503, "UPLOAD_STORAGE_UNAVAILABLE");
  return result.UploadId;
}
export async function headDirectObject(session) {
  try {
    const result = await send(new HeadObjectCommand(directObject(session)));
    if (result.Metadata?.["talkmart-session"] !== String(session._id) || result.Metadata?.["talkmart-provider"] !== String(session.providerId)) throw directError(503, "UPLOAD_OBJECT_OWNER_MISMATCH");
    if (!Number.isSafeInteger(result.ContentLength) || result.ContentLength < 0) throw directError(503, "UPLOAD_OBJECT_SIZE_UNKNOWN");
    return result;
  } catch (error) { if (missingObject(error)) return null; throw error; }
}
export async function listDirectParts(session) {
  const result = await send(new ListPartsCommand({ ...directObject(session), UploadId: session.storageUploadId, MaxParts: 1000 }));
  const parts = result.Parts || [];
  if (result.IsTruncated || parts.length > directPartCount(session) || new Set(parts.map(part => part.PartNumber)).size !== parts.length ||
      parts.some(part => !Number.isInteger(part.PartNumber) || part.PartNumber < 1 || part.PartNumber > directPartCount(session) ||
        !Number.isSafeInteger(part.Size) || part.Size < 0 || typeof part.ETag !== "string" || part.ETag.length > 200 || /[\r\n]/.test(part.ETag))) throw directError(409, "INVALID_UPLOAD_PARTS");
  return parts.sort((a, b) => a.PartNumber - b.PartNumber);
}
export async function signDirectParts(session, uploaded = []) {
  const signingDate = new Date();
  const seconds = Math.min(600, Math.floor((new Date(session.expiresAt).getTime() - signingDate.getTime()) / 1000));
  if (seconds < 1) throw directError(410, "UPLOAD_EXPIRED");
  const valid = new Set(uploaded.filter(part => part.Size === directPartSize(session, part.PartNumber)).map(part => part.PartNumber));
  const parts = [];
  for (let number = 1; number <= directPartCount(session); number++) {
    if (valid.has(number)) continue;
    const bytes = directPartSize(session, number);
    const uploadUrl = await getSignedUrl(signer, new UploadPartCommand({ ...directObject(session), UploadId: session.storageUploadId, PartNumber: number, ContentLength: bytes }),
      { expiresIn: seconds, signingDate, signableHeaders: new Set(["content-length"]) });
    parts.push({ partNumber: number, offset: (number - 1) * DIRECT_PART_BYTES, bytes, method: "PUT", uploadUrl, headers: { "Content-Length": String(bytes) } });
  }
  const urlExpiresAt = new Date(Math.floor(signingDate.getTime() / 1000) * 1000 + seconds * 1000);
  if (urlExpiresAt.getTime() <= Date.now()) throw directError(410, "UPLOAD_EXPIRED");
  return { parts, urlExpiresAt: urlExpiresAt.toISOString() };
}
export async function finishDirectMultipart(session) {
  let head = await headDirectObject(session);
  if (!head) {
    let parts;
    try { parts = await listDirectParts(session); }
    catch (error) { if (missingUpload(error)) throw directError(410, "UPLOAD_RESTART_REQUIRED"); throw error; }
    if (parts.length !== directPartCount(session) || parts.some(part => part.Size !== directPartSize(session, part.PartNumber))) throw directError(409, "UPLOAD_INCOMPLETE");
    try {
      await send(new CompleteMultipartUploadCommand({ ...directObject(session), UploadId: session.storageUploadId,
        MultipartUpload: { Parts: parts.map(part => ({ PartNumber: part.PartNumber, ETag: part.ETag })) } }));
    } catch (error) {
      // A lost Complete response is not evidence of failure. Never delete a
      // completed object or create a second video merely because it timed out.
      head = await headDirectObject(session);
      if (!head) throw error;
    }
    head ||= await headDirectObject(session);
  }
  if (!head || head.ContentLength !== session.declaredBytes || head.ContentType !== session.contentType) throw directError(409, "UPLOAD_SIZE_OR_TYPE_MISMATCH");
  return head;
}
export async function inspectDirectForCleanup(session) {
  const head = await headDirectObject(session);
  if (head) return head.ContentLength;
  if (!session.storageUploadId) return session.observedBytes || 0;
  try { return (await listDirectParts(session)).reduce((sum, part) => sum + part.Size, 0); }
  catch (error) { if (missingUpload(error)) return session.observedBytes || 0; throw error; }
}
export async function removeDirectStorage(session) {
  if (session.storageUploadId) {
    try { await send(new AbortMultipartUploadCommand({ ...directObject(session), UploadId: session.storageUploadId })); }
    catch (error) { if (!missingUpload(error)) throw error; }
  }
  {
    // CreateMultipartUpload can succeed just before its response/DB write is
    // lost. Such uploads have never had a URL issued; find their exact key.
    const result = await send(new ListMultipartUploadsCommand({ Bucket: directObject(session).Bucket, Prefix: session.sourceKey, MaxUploads: 100 }));
    if (result.IsTruncated) throw directError(503, "UPLOAD_CLEANUP_INCOMPLETE");
    for (const upload of result.Uploads || []) if (upload.Key === session.sourceKey) {
      try { await send(new AbortMultipartUploadCommand({ ...directObject(session), UploadId: upload.UploadId })); }
      catch (error) { if (!missingUpload(error)) throw error; }
    }
  }
  await send(new DeleteObjectCommand(directObject(session)));
}
