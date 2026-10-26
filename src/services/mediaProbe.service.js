import ffprobeStatic from "ffprobe-static";
import fs from "fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);


const ALLOWED_VIDEO_CODECS = new Set(["h264", "hevc", "h265", "mpeg4", "vp8", "vp9", "av1"]);
const ALLOWED_FORMATS = ["mp4", "mov", "matroska", "avi", "quicktime"];
const MAX_DURATION_SEC = 300;
const MAX_WIDTH = 3840;
const MAX_HEIGHT = 2160;

async function probeFile(filePath) {
  const { stdout } = await exec(ffprobeStatic.path, ["-v", "error", "-protocol_whitelist", "file,pipe", "-show_format", "-show_streams", "-of", "json", filePath], { timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true });
  return JSON.parse(stdout);
}

export async function validateUploadedVideo(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    const err = new Error("VIDEO_FILE_MISSING");
    err.code = "VIDEO_FILE_MISSING";
    throw err;
  }

  const header = Buffer.alloc(12);
  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, header, 0, 12, 0);
  } finally {
    fs.closeSync(fd);
  }

  const asText = header.toString("utf8");
  if (asText.startsWith("PK") || asText.startsWith("%PDF") || asText.startsWith("<!DOCTYPE") || asText.startsWith("{")) {
    const err = new Error("UNSUPPORTED_FORMAT");
    err.code = "UNSUPPORTED_FORMAT";
    throw err;
  }

  let metadata;
  try {
    metadata = await probeFile(filePath);
  } catch {
    const err = new Error("CORRUPT_VIDEO");
    err.code = "CORRUPT_VIDEO";
    throw err;
  }

  const formatName = String(metadata?.format?.format_name || "").toLowerCase();
  const duration = Number(metadata?.format?.duration || 0);
  const videoStream = (metadata?.streams || []).find((s) => s.codec_type === "video");

  if (!videoStream) {
    const err = new Error("NO_VIDEO_STREAM");
    err.code = "UNSUPPORTED_FORMAT";
    throw err;
  }

  const formatOk = ALLOWED_FORMATS.some((f) => formatName.includes(f));
  if (!formatOk) {
    const err = new Error("UNSUPPORTED_FORMAT");
    err.code = "UNSUPPORTED_FORMAT";
    throw err;
  }

  const codec = String(videoStream.codec_name || "").toLowerCase();
  if (codec && !ALLOWED_VIDEO_CODECS.has(codec)) {
    const err = new Error("UNSUPPORTED_CODEC");
    err.code = "UNSUPPORTED_FORMAT";
    throw err;
  }

  if (!Number.isFinite(duration) || duration <= 0 || (metadata.streams || []).length > 3) throw Object.assign(new Error("CORRUPT_VIDEO"), { code: "CORRUPT_VIDEO" });
  if (duration > MAX_DURATION_SEC) {
    const err = new Error("VIDEO_TOO_LONG");
    err.code = "VIDEO_TOO_LONG";
    throw err;
  }

  const width = Number(videoStream.width || 0);
  const height = Number(videoStream.height || 0);
  if (width <= 0 || height <= 0 || Math.max(width, height) > MAX_WIDTH || width * height > MAX_WIDTH * MAX_HEIGHT) {
    const err = new Error("VIDEO_RESOLUTION_TOO_HIGH");
    err.code = "VIDEO_RESOLUTION_TOO_HIGH";
    throw err;
  }

  return {
    duration: Math.round(duration || 0),
    width,
    height,
    codec,
    formatName,
  };
}
