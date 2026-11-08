import { validateVideoContentAI } from "./aiModeration.service.js";
import { compressVideo } from "./compress.service.js";
import { observe } from "../utils/metrics.js";

// Both stages read the same immutable input. Always settle both before the caller
// can remove it, including a failed encoder or an unexpected moderation error.
export async function prepareVideoMedia({ input, originalExt, categoryName, duration }, {
  analyze = validateVideoContentAI, compress = compressVideo,
} = {}) {
  const started = Date.now();
  const timed = async (name, work) => {
    const stageStarted = Date.now();
    try { return await work(); }
    finally { observe(name, Date.now() - stageStarted); }
  };
  try {
    const [ai, media] = await Promise.allSettled([
      timed("ai_ms", () => analyze({ tempFilePath: input, categoryName, duration })),
      timed("ffmpeg_ms", () => compress(input, originalExt)),
    ]);
    if (ai.status === "rejected" || media.status === "rejected") {
      if (media.status === "fulfilled") media.value.cleanup();
      throw media.status === "rejected" ? media.reason : ai.reason;
    }
    return { ai: ai.value, compressed: media.value };
  } finally { observe("preparation_ms", Date.now() - started); }
}
