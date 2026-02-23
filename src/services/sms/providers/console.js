export async function sendSmsConsole({ to, text }) {
  console.log("📩 SMS (console):", { to, text });
  return { ok: true };
}
