export async function sendSmsConsole({ to, text }) {
  console.log("📩 SMS:", to);
  console.log("📩 Message:", text);

  return { ok: true };
}
