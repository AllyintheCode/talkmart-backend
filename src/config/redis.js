import { logger } from "../utils/logger.js";
import Redis from "ioredis";

const REDIS_HOST = process.env.REDIS_HOST || "127.0.0.1";
const REDIS_PORT = parseInt(process.env.REDIS_PORT || "6379", 10);
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined;

let redis = null;
let isRedisConnected = false;

try {
  redis = new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    password: REDIS_PASSWORD,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy(times) {
      // Əgər Redis sönübsə, server donmasın, arxa planda hər 5 saniyədən bir yoxlasın
      return Math.min(times * 1000, 5000);
    },
    enableOfflineQueue: false, // Əlaqə olmayanda sorğuları yığıb RAM-ı şişirtməsin
  });

  redis.on("connect", () => {
    isRedisConnected = false;
    logger.log("⚡ Redis: Qoşuldu");
  });

  redis.on("ready", () => {
    isRedisConnected = true;
  });

  redis.on("error", (err) => {
    isRedisConnected = false;
    // Sadəcə xəbərdarlıq yaz, serveri dayandırma
    // logger.warn("⚠️ Redis əlaqə xətası (Server MongoDB ilə işləməyə davam edir):", err.message);
  });

  redis.on("close", () => {
    isRedisConnected = false;
  });

  // Arxa planda qoşulmağa cəhd et
  if (process.env.NODE_ENV !== "test" && process.env.REDIS_DISABLED !== "true") redis.connect().catch(() => {
    // logger.warn("⚠️ Redis lokal olaraq aktiv deyil. Keşsiz rejimdə işləyir.");
  });
} catch (err) {
  logger.warn("⚠️ Redis client yaradıla bilmədi:", err.message);
}

/**
 * Keşdən məlumat oxumaq (JSON avtomatik parse edilir)
 */
export async function getCache(key) {
  if (!isRedisConnected || !redis) return null;
  try {
    const data = await redis.get(key);
    return data ? JSON.parse(data) : null;
  } catch (err) {
    return null;
  }
}

/**
 * Məlumatı keşə yazmaq
 * @param {string} key - Açar söz
 * @param {any} value - Saxlanılacaq məlumat
 * @param {number} ttlSeconds - Yaşama müddəti (saniyə ilə, default: 60 saniyə)
 */
export async function setCache(key, value, ttlSeconds = 60) {
  if (!isRedisConnected || !redis) return false;
  try {
    const serialized = JSON.stringify(value);
    if (ttlSeconds > 0) {
      await redis.set(key, serialized, "EX", ttlSeconds);
    } else {
      await redis.set(key, serialized);
    }
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Tək açarı keşdən silmək
 */
export async function delCache(key) {
  if (!isRedisConnected || !redis) return false;
  try {
    await redis.del(key);
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Müəyyən prefikslə olan bütün açarları silmək (Məs: "feed:*")
 * O(N) keys() yerinə təhlükəsiz və bloklamayan SCAN istifadə olunur (TM-024)
 */
export async function delCachePattern(pattern) {
  if (!isRedisConnected || !redis) return false;
  try {
    let cursor = "0";
    do {
      const [nextCursor, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
      cursor = nextCursor;
      if (keys && keys.length > 0) {
        await redis.del(...keys);
      }
    } while (cursor !== "0");
    return true;
  } catch (err) {
    return false;
  }
}

export function getRedisClient() { return isRedisConnected ? redis : null; }
export default redis;
