import { sendSmsConsole } from "./providers/console.js";
import { sendSmsInfobip } from "./providers/infobip.js";

export async function sendSms({ to, text }) {
  console.log("📌 SMS_PROVIDER =", process.env.SMS_PROVIDER);
  const provider = process.env.SMS_PROVIDER || "console";

  if (provider === "infobip") return sendSmsInfobip({ to, text });
  if (provider === "console") return sendSmsConsole({ to, text });

  throw new Error("SMS_PROVIDER yanlışdır: " + provider);
}
