import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { prepareVideoMedia } from "../src/services/mediaPreparation.service.js";

const input = { input: "owned-input.mp4", originalExt: ".mp4", categoryName: "Synthetic service", duration: 1 };
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test("moderation and encoding overlap while the result waits for both stages", async () => {
  const ai = gate(), media = gate(), started = [];
  let cleaned = 0, settled = false;
  const output = { cleanup: () => { cleaned++; } };
  const task = prepareVideoMedia(input, {
    analyze: async () => { started.push("ai"); return ai.promise; },
    compress: async () => { started.push("media"); return media.promise; },
  });
  task.then(() => { settled = true; });
  assert.deepEqual(started, ["ai", "media"]);
  media.resolve(output); await setImmediate();
  assert.equal(settled, false); assert.equal(cleaned, 0);
  ai.resolve({ finalStatus: "review" });
  const result = await task;
  assert.equal(result.ai.finalStatus, "review"); assert.equal(result.compressed, output);
  assert.equal(cleaned, 0); output.cleanup();
});

test("encoder failure waits for moderation to finish before input can be cleaned", async () => {
  const ai = gate(), failure = new Error("ENCODER_FAILED");
  let settled = false, aiFinished = false;
  const task = prepareVideoMedia(input, {
    analyze: async () => { await ai.promise; aiFinished = true; return { finalStatus: "review" }; },
    compress: () => { throw failure; },
  });
  const rejected = assert.rejects(task, error => error === failure && aiFinished);
  task.catch(() => { settled = true; });
  await setImmediate(); assert.equal(settled, false);
  ai.resolve(); await rejected;
});

test("unexpected moderation failure cleans a late encoder output exactly once", async () => {
  const media = gate(), failure = new Error("MODERATION_FAILED");
  let cleaned = 0, settled = false;
  const task = prepareVideoMedia(input, {
    analyze: async () => { throw failure; },
    compress: async () => { await media.promise; return { cleanup: () => { cleaned++; } }; },
  });
  const rejected = assert.rejects(task, error => error === failure);
  task.catch(() => { settled = true; });
  await setImmediate(); assert.equal(settled, false); assert.equal(cleaned, 0);
  media.resolve(); await rejected; assert.equal(cleaned, 1);
});
