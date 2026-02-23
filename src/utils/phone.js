export function normalizeAzPhone(input) {
  const digits = String(input || "").replace(/\D/g, "");

  let d = digits;

  // 00994... -> 994...
  if (d.startsWith("00")) d = d.slice(2);

  // 0xxxxxxxxx -> 994xxxxxxxxx
  if (d.startsWith("0")) d = "994" + d.slice(1);

  // artıq 994 ilə başlamalıdır
  if (!d.startsWith("994")) {
    throw new Error("Telefon formatı yanlışdır. Məs: +994501234567");
  }

  return "+" + d;
}
