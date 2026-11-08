import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn, execFile, execFileSync } from "node:child_process";
import { once } from "node:events";
import { promisify, parseArgs } from "node:util";
import { performance } from "node:perf_hooks";
import { isolatedEnvironment, assertIsolatedServices, reportDirectory, machine, summary, sourceRevision } from "./common.js";

const { values } = parseArgs({ options: { input: { type: "string" }, runs: { type: "string", default: "1" },
  "isolated-worker": { type: "boolean", default: false }, help: { type: "boolean", default: false } } });
if (values.help) { console.log("node scripts/perf/media.js [--input=path/to/video.mp4] [--runs=1]\nDefault: two small synthetic clips. No Gemini, SMTP, R2 or worker jobs are called."); process.exit(0); }
const runs = Number(values.runs);
if (!Number.isInteger(runs) || runs < 1 || runs > 3) throw new Error("MEDIA_RUNS_MUST_BE_1_TO_3");

if (!values["isolated-worker"]) {
  const directory = await reportDirectory("media"), runId = crypto.randomUUID().replaceAll("-", "");
  const env = isolatedEnvironment({ runId, uri: `mongodb://127.0.0.1:1/talkmart_perf_${runId}`, directory });
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2), "--isolated-worker"],
    { stdio: "inherit", env: { ...env, PERF_REPORT_DIRECTORY: directory } });
  const [code] = await once(child, "exit");
  process.exitCode = code ?? 1;
} else {
  assertIsolatedServices(process.env);
  const directory = process.env.PERF_REPORT_DIRECTORY;
  if (!directory || path.dirname(await fs.realpath(directory)) !== await fs.realpath("tmp/performance")) throw new Error("MEDIA_REPORT_DIRECTORY_NOT_OWNED");
  const { default: ffmpeg } = await import("ffmpeg-static");
  const { validateUploadedVideo } = await import("../../src/services/mediaProbe.service.js");
  const { extractKeyframes } = await import("../../src/services/aiModeration.service.js");
  const { compressVideo, generateThumbnail } = await import("../../src/services/compress.service.js");
  const { default: redis } = await import("../../src/config/redis.js");
  const exec = promisify(execFile);
  async function packetHashes(filename, metadata) {
    const { default: ffprobe } = await import("ffprobe-static");
    const { stdout } = await exec(ffprobe.path, ["-v", "error", "-show_packets", "-show_data_hash", "sha256", "-show_entries", "packet=stream_index,data_hash", "-of", "json", filename],
      { timeout: 30000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    const streams = {};
    for (const packet of JSON.parse(stdout).packets) (streams[packet.stream_index] ||= []).push(packet.data_hash);
    return { video: streams[metadata.videoStreamIndex] || [], audio: metadata.audioStreamIndex === null ? [] : streams[metadata.audioStreamIndex] || [] };
  }
  const report = { kind: "local-media-baseline", machine: machine(), baselineCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    source: await sourceRevision(),
    startedAt: new Date().toISOString(), inputKind: values.input ? "provided-local-file" : "synthetic-generated", runs, cases: [], excludes: ["Gemini network/model latency", "upload/download", "R2/CDN", "queue waiting", "FFmpeg child CPU/RAM", "quality metrics and mobile playback"],
    note: "Few local trials describe these clips only. They cannot establish a processing p95 SLO or production capacity." };
  async function hash(filename) {
    const digest = crypto.createHash("sha256");
    for await (const chunk of createReadStream(filename)) digest.update(chunk);
    return digest.digest("hex");
  }
  try {
    let files;
    if (values.input) files = [path.resolve(values.input)];
    else {
      files = [];
      for (const fixture of [{ name: "synthetic-720p", size: "1280x720", duration: 6 }, { name: "synthetic-portrait-1080p", size: "1080x1920", duration: 3 }]) {
        const filename = path.join(directory, fixture.name + ".mp4");
        console.log("Generating local fixture:", fixture.name);
        await exec(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=size=${fixture.size}:rate=25:duration=${fixture.duration}`,
          "-filter_threads", "1", "-c:v", "libx264", "-threads", "2", "-preset", "fast", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-y", filename],
        { timeout: 90000, windowsHide: true, maxBuffer: 1024 * 1024 });
        files.push(filename);
      }
    }
    for (const filename of files) {
      const stat = await fs.stat(filename);
      if (!stat.isFile() || stat.size > 250 * 1024 * 1024) throw new Error("INVALID_LOCAL_MEDIA_INPUT");
      const beforeHash = await hash(filename), trials = [];
      const item = { file: path.basename(filename), inputBytes: stat.size, inputSha256: beforeHash, trials };
      report.cases.push(item);
      for (let trial = 0; trial < runs; trial++) {
        let output;
        const measured = {};
        trials.push(measured);
        try {
          console.log(`Measuring ${path.basename(filename)}, trial ${trial + 1}: probe / frames / current transcode / thumbnail`);
          let start = performance.now();
          const metadata = await validateUploadedVideo(filename);
          measured.probeMs = performance.now() - start;
          item.metadata = metadata;
          start = performance.now();
          try {
            const frames = await extractKeyframes(filename, 4, metadata.duration);
            measured.framesMs = performance.now() - start;
            measured.frameCount = frames.length;
          } catch (error) {
            measured.framesMs = performance.now() - start;
            measured.frameError = error.code || error.name;
            process.exitCode = 1;
          }
          start = performance.now();
          output = await compressVideo(filename, path.extname(filename));
          measured.transcodeMs = performance.now() - start;
          measured.processingMode = output.processingMode || "transcode";
          measured.outputBytes = (await fs.stat(output.outputPath)).size;
          const outputMetadata = await validateUploadedVideo(output.outputPath);
          measured.outputMetadata = outputMetadata;
          if (measured.processingMode === "remux") {
            const beforePackets = await packetHashes(filename, metadata), afterPackets = await packetHashes(output.outputPath, outputMetadata);
            measured.encodedPacketsUnchanged = JSON.stringify(beforePackets) === JSON.stringify(afterPackets);
            measured.videoPackets = afterPackets.video.length; measured.audioPackets = afterPackets.audio.length;
            if (!measured.encodedPacketsUnchanged) throw new Error("REMUX_PACKETS_CHANGED");
          }
          start = performance.now();
          const thumbnail = await generateThumbnail(filename, path.extname(filename));
          measured.thumbnailMs = performance.now() - start;
          measured.thumbnailBytes = thumbnail.buffer.length;
          measured.sequentialMeasuredStagesMs = measured.probeMs + measured.framesMs + measured.transcodeMs + measured.thumbnailMs;
          console.log(`${item.file}: frames=${measured.framesMs.toFixed(0)} ms, transcode=${measured.transcodeMs.toFixed(0)} ms, output=${measured.outputBytes} bytes`);
        } catch (error) { measured.error = error.code || error.message; process.exitCode = 1; }
        finally { output?.cleanup(); }
      }
      if (beforeHash !== await hash(filename)) throw new Error("SOURCE_MEDIA_CHANGED");
      item.sourceUnchanged = true;
      const timings = summary(trials.filter(trial => !trial.error).map(trial => trial.transcodeMs));
      item.transcodeWallMs = { trials: timings.samples, mean: timings.mean, max: timings.max };
    }
  } catch (error) { report.failure = error.code || error.message; process.exitCode = 1; }
  finally {
    redis?.disconnect();
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(directory, "media-report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
    const lines = ["# Local media baseline", "", report.note, "", "| File | Size MB | Resolution | Frames ms | Mode | Prepare ms | Output MB |", "|---|---:|---|---:|---|---:|---:|"];
    for (const item of report.cases) for (const trial of item.trials) lines.push(`| ${item.file} | ${(item.inputBytes / 1e6).toFixed(2)} | ${item.metadata?.width ?? "?"}x${item.metadata?.height ?? "?"} | ${trial.framesMs?.toFixed(0) ?? "n/a"}${trial.frameError ? " (" + trial.frameError + ")" : ""} | ${trial.processingMode || "n/a"} | ${trial.transcodeMs?.toFixed(0) ?? "n/a"} | ${trial.outputBytes ? (trial.outputBytes / 1e6).toFixed(2) : "n/a"} |`);
    if (report.failure) lines.push("", "Run failed: " + report.failure);
    lines.push("", "Not measured: " + report.excludes.join(", ") + ". Original input hashes are checked after the run.");
    await fs.writeFile(path.join(directory, "media-report.md"), lines.join("\n") + "\n");
    console.log("Report:", path.join(directory, "media-report.md"));
  }
}
