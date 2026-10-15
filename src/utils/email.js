import nodemailer from "nodemailer";

const isSecure =
  process.env.SMTP_SECURE === "true" || Number(process.env.SMTP_PORT) === 465;

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587,
  secure: isSecure,
  requireTLS: !isSecure,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

/**
 * Göndərən From başlığını təyin edir.
 * Əgər Gmail SMTP istifadə olunursa və From ünvanı Gmail deyil kənar domendirrsə,
 * Gmail SMTP həmin domen üçün DKIM imzalaya bilmədiyindən və SPF fail olduğundan
 * məktub spama düşür. Bu halda autentifikasiya olunmuş Gmail ünvanından istifadə edilir.
 */
export function getSenderAddress() {
  const fromName = process.env.FROM_NAME || "Talkmart";
  let from = (process.env.FROM_EMAIL || process.env.SMTP_USER || "").trim();
  const isGmail = (process.env.SMTP_HOST || "").toLowerCase().includes("gmail.com");
  const smtpUser = (process.env.SMTP_USER || "").trim();

  if (isGmail && smtpUser) {
    const emailMatch = from.match(/<([^>]+)>/) || [null, from];
    const emailAddr = (emailMatch[1] || from).trim();
    if (!emailAddr.endsWith("@gmail.com") && !emailAddr.endsWith("@googlemail.com")) {
      console.warn(
        `[Email Deliverability] Gmail SMTP kənar domenlə (${emailAddr}) göndərişdə SPF/DKIM uyğunsuzluğu və Spam yaradır. From ünvanı "${fromName}" <${smtpUser}> olaraq təyin edildi.`
      );
      return `"${fromName}" <${smtpUser}>`;
    }
  }

  if (from && !from.includes("<")) {
    return `"${fromName}" <${from}>`;
  }

  return from || `"${fromName}" <${smtpUser}>`;
}

export async function sendEmailOtp(to, code, purpose = "login") {
  const from = getSenderAddress();
  const replyTo = process.env.REPLY_TO_EMAIL || "support@talkmart.az";

  const titles = {
    register: "Qeydiyyat kodu",
    forgot_password: "Şifrə sıfırlama kodu",
    login: "Giriş kodu",
    email_change: "Email dəyişmə təsdiq kodu",
  };
  const title = titles[purpose] || "Təsdiq kodu";
  const currentYear = new Date().getFullYear();

  console.log(`[OTP DEBUG] Sending OTP ${code} to ${to} for purpose: ${purpose}`);

  const htmlTemplate = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="az" xml:lang="az">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light" />
  <meta name="supported-color-schemes" content="light" />
  <title>Talkmart — ${title}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f6f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; color: #1e293b;">
  <!-- Gizli preheader mətni poçt qutusunda ilkin baxış üçün -->
  <div style="display: none; font-size: 1px; color: #ffffff; line-height: 1px; max-height: 0px; max-width: 0px; opacity: 0; overflow: hidden; mso-hide: all;">
    Sizin Talkmart ${title.toLowerCase()} təsdiq kodunuz: ${code}. Kod 10 dəqiqə ərzində etibarlıdır.
  </div>

  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f4f6f9; padding: 30px 15px;">
    <tr>
      <td align="center">
        <!-- Əsas Kart -->
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 540px; background-color: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 4px 12px rgba(15, 23, 42, 0.05);">
          <!-- Başlıq -->
          <tr>
            <td style="background-color: #1a73e8; padding: 24px 32px; text-align: center;">
              <h1 style="margin: 0; font-size: 24px; font-weight: 700; color: #ffffff; letter-spacing: 0.5px;">Talkmart</h1>
            </td>
          </tr>

          <!-- Əsas Məzmun -->
          <tr>
            <td style="padding: 32px 32px 24px 32px;">
              <p style="margin: 0 0 16px 0; font-size: 16px; font-weight: 600; color: #0f172a;">Salam,</p>
              <p style="margin: 0 0 24px 0; font-size: 15px; line-height: 1.6; color: #475569;">
                Sizin <strong>${title.toLowerCase()}</strong> üçün tələb etdiyiniz birdəfəlik təsdiq şifrəsi (OTP):
              </p>

              <!-- OTP Kod Bloku -->
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin: 20px 0 24px 0;">
                <tr>
                  <td align="center" style="background-color: #f0f7ff; border: 1.5px dashed #2563eb; border-radius: 10px; padding: 20px 10px;">
                    <span style="font-family: 'Courier New', Courier, monospace; font-size: 34px; font-weight: 700; letter-spacing: 8px; color: #1a73e8; display: inline-block;">
                      ${code}
                    </span>
                  </td>
                </tr>
              </table>

              <!-- Xəbərdarlıq qutusu -->
              <div style="background-color: #fffbeb; border-left: 4px solid #f59e0b; padding: 12px 16px; border-radius: 4px; margin-bottom: 24px;">
                <p style="margin: 0; font-size: 13px; line-height: 1.5; color: #92400e;">
                  ⏱️ Bu kod <strong>10 dəqiqə</strong> ərzində etibarlıdır. Təhlükəsizliyiniz üçün kodu heç kimlə paylaşmayın.
                </p>
              </div>

              <p style="margin: 0; font-size: 13px; line-height: 1.5; color: #64748b;">
                Əgər bu əməliyyatı siz həyata keçirməmisinizsə, narahat olmayın və bu məktubu sadəcə görməzdən gəlin.
              </p>
            </td>
          </tr>

          <!-- Ayırıcı Xətt -->
          <tr>
            <td style="padding: 0 32px;">
              <div style="border-top: 1px solid #e2e8f0;"></div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 24px 32px; background-color: #fafbfd; text-align: center;">
              <p style="margin: 0 0 6px 0; font-size: 12px; color: #64748b;">
                Bu avtomatik bildiriş məktubudur. Əlaqə və dəstək üçün: <a href="mailto:${replyTo}" style="color: #1a73e8; text-decoration: none;">${replyTo}</a>
              </p>
              <p style="margin: 0; font-size: 12px; color: #94a3b8;">
                © ${currentYear} Talkmart. Bütün hüquqlar qorunur.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  await transporter.sendMail({
    from,
    to,
    replyTo,
    subject: `Talkmart — ${title}`,
    text: `Salam,\n\nSizin ${title.toLowerCase()} üçün tələb etdiyiniz birdəfəlik təsdiq kodu (OTP): ${code}\n\nBu kod 10 dəqiqə ərzində etibarlıdır.\nTəhlükəsizliyiniz üçün kodu heç kimlə paylaşmayın.\n\nƏgər bu sorğunu siz etməmisinizsə, bu məktubu görməzdən gələ bilərsiniz.\n\nDəstək: ${replyTo}\n© ${currentYear} Talkmart. Bütün hüquqlar qorunur.`,
    html: htmlTemplate,
    headers: {
      "X-Priority": "1",
      "Importance": "high",
      "Auto-Submitted": "auto-generated",
      "X-Auto-Response-Suppress": "All",
    },
  });
}

export async function sendAdminNotification(subject, text) {
  const from = getSenderAddress();
  const to = process.env.ADMIN_EMAIL || process.env.SMTP_USER;
  try {
    await transporter.sendMail({
      from,
      to,
      subject: `Talkmart Admin Alert: ${subject}`,
      text,
      headers: {
        "Auto-Submitted": "auto-generated",
      },
    });
  } catch (err) {
    console.error("Failed to send admin notification:", err);
  }
}
