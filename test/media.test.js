import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffmpeg from "ffmpeg-static";
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
