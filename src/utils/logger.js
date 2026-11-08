const sensitiveKey = /password|secret|token|authorization|cookie|otp|pepper|api.?key|mongo.*uri|smtp.*pass|email|phone/i;
export function redact(value, seen = new WeakSet()) {
  if (typeof value === "string") {
    let result = value;
    result = result.replace(/https?:\/\/[^\s"'<>]+/gi, url =>
      /[?&]X-Amz-(?:Signature|Credential|Security-Token)=/i.test(url) ? "[REDACTED_MEDIA_URL]" : url);
    for (const [key, secret] of Object.entries(process.env)) {
      if (sensitiveKey.test(key) && secret && secret.length >= 4) {
        for (const part of [secret, ...secret.split(",")]) {
          if (part.length >= 4) result = result.split(part).join("[REDACTED]");
        }
      }
    }
    return result.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
      .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[REDACTED]")
      .replace(/mongodb(?:\+srv)?:\/\/\S+/gi, "[REDACTED]")
      .replace(/\b\d{6}\b/g, "[REDACTED]")
      .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[REDACTED]");
  }
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value.toHexString === "function") return value.toHexString();
  if (value instanceof Error) return { name: value.name, code: value.code, message: redact(value.message, seen) };
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitiveKey.test(key) ? "[REDACTED]" : redact(item, seen)]));
}
export const logger = Object.fromEntries(["log", "info", "warn", "error"].map((level) => [
  level, (...args) => console[level](...args.map((arg) => redact(arg))),
]));
