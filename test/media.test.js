import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffmpeg from "ffmpeg-static";
import sharp from "sharp";
import { validateUploadedVideo } from "../src/services/mediaProbe.service.js";
import { compressVideo, generateThumbnail } from "../src/services/compress.service.js";
import { extractKeyframes } from "../src/services/aiModeration.service.js";
const exec = promisify(execFile);

test("real FFprobe, compression and frames reject forged MIME and clean their files", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "talkmart-test-"));
  try {
    const input = path.join(directory, "valid.mp4");
    await exec(ffmpeg, ["-f", "lavfi", "-i", "color=c=blue:s=160x120:d=1", "-c:v", "libx264", "-y", input], { windowsHide: true });
    const metadata = await validateUploadedVideo(input);
    assert.equal(metadata.width, 160);
    const compressed = await compressVideo(input);
    assert.ok((await fs.stat(compressed.outputPath)).size > 0);
    assert.equal(compressed.buffer, undefined);
    compressed.cleanup();
    await assert.rejects(fs.stat(compressed.outputPath));
    assert.ok((await generateThumbnail(input)).buffer.length > 0);
    assert.equal((await extractKeyframes(input, 2, 1)).length, 2);
    for (const [name, content] of [["text.mp4", "not a video"], ["archive.mp4", "PK fake archive"], ["corrupt.mp4", Buffer.from([0, 0, 0, 20, 102, 116, 121, 112])]]) {
      const target = path.join(directory, name);
      await fs.writeFile(target, content);
      await assert.rejects(validateUploadedVideo(target));
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("portrait 4K keyframes preserve a shared deadline and clean up on timeout", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "talkmart-test-"));
  const frameDirectories = async () => (await fs.readdir(os.tmpdir())).filter(name => name.startsWith("talkmart-frames-")).sort();
  try {
    const input = path.join(directory, "portrait-4k.mp4");
    await exec(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=2160x3840:r=25:d=2",
      "-c:v", "libx264", "-threads", "2", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-y", input], { timeout: 30000, windowsHide: true });
    const metadata = await validateUploadedVideo(input);
    assert.equal(metadata.width, 2160);
    assert.equal(metadata.height, 3840);
    const before = await frameDirectories();
    const frames = await extractKeyframes(input, 4, 2);
    assert.equal(frames.length, 4);
    for (const frame of frames) {
      const image = await sharp(Buffer.from(frame, "base64")).metadata();
      assert.equal(image.format, "jpeg");
      assert.equal(image.width, 640);
      assert.ok(image.height > image.width);
    }
    assert.deepEqual(await frameDirectories(), before);
    await assert.rejects(extractKeyframes(input, 4, 2, { deadline: Date.now() - 1 }), { code: "AI_FRAME_TIMEOUT" });
    assert.deepEqual(await frameDirectories(), before);
    await assert.rejects(extractKeyframes(input, 4, 2, { deadline: Date.now() + 25 }), { code: "AI_FRAME_TIMEOUT" });
    assert.deepEqual(await frameDirectories(), before);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("short and long video samples cover all four time windows and reject incomplete sampling", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "talkmart-test-"));
  try {
    const colors = [["red", [255, 0, 0]], ["green", [0, 128, 0]], ["blue", [0, 0, 255]], ["yellow", [255, 255, 0]]];
    for (const duration of [8, 60]) {
      const input = path.join(directory, `samples-${duration}.mp4`);
      const inputs = colors.flatMap(([color]) => ["-f", "lavfi", "-i", `color=c=${color}:s=160x120:r=10:d=${duration / 4}`]);
      await exec(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", ...inputs,
        "-filter_complex_threads", "1", "-filter_complex", "[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0",
        "-c:v", "libx264", "-threads", "2", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-y", input],
      { timeout: 30000, windowsHide: true });
      const frames = await extractKeyframes(input, 4, duration);
      assert.equal(frames.length, 4);
      for (let i = 0; i < frames.length; i++) {
        const pixel = await sharp(Buffer.from(frames[i], "base64")).resize(1, 1).raw().toBuffer();
        for (let channel = 0; channel < 3; channel++) assert.ok(Math.abs(pixel[channel] - colors[i][1][channel]) < 20);
      }
      if (duration === 8) await assert.rejects(extractKeyframes(input, 4, 20), { code: "AI_FRAMES_INCOMPLETE" });
    }
    await assert.rejects(extractKeyframes(path.join(directory, "samples-8.mp4"), 0, 8), { code: "AI_FRAME_PARAMETERS" });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
