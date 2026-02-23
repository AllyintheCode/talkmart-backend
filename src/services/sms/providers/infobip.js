import axios from "axios";

export async function sendSmsInfobip({ to, text }) {
  const baseUrl = process.env.INFOBIP_BASE_URL;
  const apiKey = process.env.INFOBIP_API_KEY;
  const sender = process.env.INFOBIP_SENDER || "Talkmart";

  if (!baseUrl) throw new Error("INFOBIP_BASE_URL yoxdur");
  if (!apiKey) throw new Error("INFOBIP_API_KEY yoxdur");

  const url = `${baseUrl}/sms/2/text/advanced`;

  const payload = {
    messages: [
      {
        from: sender,
        destinations: [{ to }], // +994...
        text,
      },
    ],
  };

  try {
    const res = await axios.post(url, payload, {
      headers: {
        Authorization: `App ${apiKey}`, // Infobip API key auth :contentReference[oaicite:1]{index=1}
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      timeout: 15000,
    });

    console.log("✅ Infobip response:", JSON.stringify(res.data, null, 2));
    return { ok: true, data: res.data };
  } catch (err) {
    const data = err?.response?.data;
    console.error(
      "❌ Infobip error:",
      JSON.stringify(data || err.message, null, 2),
    );
    throw new Error(
      data?.requestError?.serviceException?.text || "Infobip SMS failed",
    );
  }
}
