import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffprobe from "ffprobe-static";
const exec = promisify(execFile);
const MIN_PROBE_BYTES = 8 * 1024 * 1024;
export const SINGLE_PASS_MAX_SECONDS = 30;

// Packet timestamps only choose the cheaper decoder path. Both paths still
// decode an accurate frame at each of the same four window centres.
export function planFrameSampling(metadata, count, duration) {
  const fallback = { strategy: "single-pass" };
  const stream = metadata?.streams?.[0];
  if (count < 2 || count > 4 || !Number.isInteger(count) || duration < 8 || duration > SINGLE_PASS_MAX_SECONDS ||
      !Number.isFinite(duration) || !(stream?.width * stream?.height >= 1920 * 1080) ||
      stream.start_time == null || stream.start_time === "" || !Number.isFinite(Number(stream.start_time)) || Math.abs(Number(stream.start_time)) > 0.001 ||
      metadata?.format?.start_time == null || metadata.format.start_time === "" || !Number.isFinite(Number(metadata.format.start_time)) || Math.abs(Number(metadata.format.start_time)) > 0.001 ||
      !Array.isArray(metadata.packets)) return fallback;
  const keyframes = metadata.packets.filter(packet => String(packet.flags).includes("K"))
    .map(packet => packet.pts_time == null || packet.pts_time === "" ? NaN : Number(packet.pts_time)).sort((a, b) => a - b);
  if (!keyframes.length || keyframes.some(time => !Number.isFinite(time) || time < 0) || keyframes[0] > 0.001) return fallback;
  const samples = Array.from({ length: count }, (_, index) => {
    const position = duration / count * (index + 0.5);
    const keyframe = keyframes.findLast(time => time <= position) ?? 0;
    return { position, decodeSeconds: position - keyframe };
  });
  const singlePassSeconds = samples.at(-1).position - (keyframes.findLast(time => time <= samples[0].position) ?? 0);
  const seekSeconds = samples.reduce((sum, sample) => sum + sample.decodeSeconds, 0);
  // Leave headroom for three extra process launches and demuxer setup. Long GOPs
  // retain the single pass that fixed the original portrait-4K timeout.
  if (seekSeconds + 0.6 > singlePassSeconds * 0.65) return fallback;
  return { strategy: "sequential-seek", estimatedDecodeSeconds: seekSeconds, singlePassSeconds };
}

export async function chooseFrameSampling(filePath, count, duration, deadline) {
  if (duration > SINGLE_PASS_MAX_SECONDS) return { strategy: "sequential-seek" };
  const fallback = { strategy: "single-pass" };
  if (duration < 8 || count < 2 || deadline - Date.now() < 1500 || (await fs.stat(filePath)).size < MIN_PROBE_BYTES) return fallback;
  try {
    const { stdout } = await exec(ffprobe.path, ["-v", "error", "-protocol_whitelist", "file,pipe", "-select_streams", "v:0",
      "-show_packets", "-show_entries", "packet=pts_time,flags:stream=width,height,start_time:format=start_time", "-of", "json", filePath],
    { timeout: Math.min(750, deadline - Date.now()), killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024, windowsHide: true });
    return planFrameSampling(JSON.parse(stdout), count, duration);
  } catch {
    // An unavailable packet index is not a moderation failure or an approval:
    // use the existing decoder path, under the same overall deadline.
    return fallback;
  }
}
