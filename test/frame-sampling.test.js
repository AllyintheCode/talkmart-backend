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
import { planFrameSampling } from "../src/services/frameSampling.service.js";
import { extractKeyframes } from "../src/services/aiModeration.service.js";
const exec = promisify(execFile);

test("sampling planner skips short GOP gaps but retains single-pass decoding for long GOPs and uncertain timestamps", () => {
  const metadata = { streams: [{ width: 2160, height: 3840, start_time: "0" }], format: { start_time: "0" },
    packets: [0, 3.04, 6.08, 9.12, 12.16, 15.2, 18.24].map(time => ({ pts_time: String(time), flags: "K_" })) };
  const plan = planFrameSampling(metadata, 4, 20);
  assert.equal(plan.strategy, "sequential-seek");
  assert.ok(Math.abs(plan.estimatedDecodeSeconds - 6.56) < 0.001);
  assert.equal(plan.singlePassSeconds, 17.5);
  assert.equal(planFrameSampling({ ...metadata, packets: [0, 10, 20].map(time => ({ pts_time: String(time), flags: "K_" })) }, 4, 20).strategy, "single-pass");
  for (const change of [
    { streams: [{ width: 160, height: 120, start_time: "0" }] },
    { streams: [{ width: 2160, height: 3840, start_time: "1" }] },
    { format: { start_time: "1" } }, { format: {} }, { format: { start_time: null } },
    { packets: [] }, { packets: [{ flags: "K_", pts_time: "bad" }] }, { packets: [{ flags: "K_", pts_time: null }] },
  ]) assert.equal(planFrameSampling({ ...metadata, ...change }, 4, 20).strategy, "single-pass");
});

test("adaptive real decoders cover four windows, retain the long-GOP path and reject incomplete samples", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "talkmart-sampling-test-"));
  const ownedFrames = async () => (await fs.readdir(os.tmpdir())).filter(name => name.startsWith("talkmart-frames-")).sort();
  try {
    const colors = [["red", [255, 0, 0]], ["green", [0, 128, 0]], ["blue", [0, 0, 255]], ["yellow", [255, 255, 0]]];
    for (const gop of [25, 250]) {
      const input = path.join(directory, `gop-${gop}.mp4`);
      const inputs = colors.flatMap(([color]) => ["-f", "lavfi", "-i", `color=c=${color}:s=1920x1080:r=25:d=2`]);
      await exec(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", ...inputs,
        "-filter_complex_threads", "1", "-filter_complex", "[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0",
        "-c:v", "libx264", "-threads", "2", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", String(gop), "-keyint_min", String(gop),
        "-b:v", "12M", "-minrate", "12M", "-maxrate", "12M", "-bufsize", "24M", "-x264-params", "nal-hrd=cbr:scenecut=0", "-y", input],
      { timeout: 30000, windowsHide: true });
      assert.ok((await fs.stat(input)).size >= 8 * 1024 * 1024);
      const before = await ownedFrames();
      let plan;
      const frames = await extractKeyframes(input, 4, 8, { onPlan: chosen => { plan = chosen; } });
      assert.equal(plan.strategy, gop === 25 ? "sequential-seek" : "single-pass");
      assert.equal(frames.length, 4);
      for (let i = 0; i < frames.length; i++) {
        const pixel = await sharp(Buffer.from(frames[i], "base64")).resize(1, 1).raw().toBuffer();
        for (let channel = 0; channel < 3; channel++) assert.ok(Math.abs(pixel[channel] - colors[i][1][channel]) < 20);
      }
      assert.deepEqual(await ownedFrames(), before);
      if (gop === 25) {
        await assert.rejects(extractKeyframes(input, 4, 8, { deadline: Date.now() + 25 }), { code: "AI_FRAME_TIMEOUT" });
        assert.deepEqual(await ownedFrames(), before);
        await assert.rejects(extractKeyframes(input, 4, 20), { code: "AI_FRAMES_INCOMPLETE" });
        assert.deepEqual(await ownedFrames(), before);
      }
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
