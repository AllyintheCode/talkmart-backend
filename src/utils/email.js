import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587,
  secure: false, // 587 üçün false
  requireTLS: true, // STARTTLS
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

export async function sendEmailOtp(to, code, purpose = "login") {
  const from = process.env.FROM_EMAIL || process.env.SMTP_USER;

  const titles = {
    register: "Qeydiyyat kodu",
    forgot_password: "Şifrə sıfırlama kodu",
    login: "Giriş kodu",
    email_change: "Email dəyişmə təsdiq kodu",
  };
  const title = titles[purpose] || "Təsdiq kodu";

  console.log(`[OTP DEBUG] Sending OTP ${code} to ${to} for purpose: ${purpose}`);

  const htmlTemplate = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <style>
      body {
        font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        background-color: #f9f9f9;
        margin: 0;
        padding: 0;
      }
      .container {
        max-width: 600px;
        margin: 40px auto;
        background-color: #ffffff;
        border-radius: 8px;
        overflow: hidden;
        box-shadow: 0 4px 15px rgba(0,0,0,0.05);
      }
      .header {
        background-color: #1a73e8;
        color: #ffffff;
        padding: 20px;
        text-align: center;
      }
      .content {
        padding: 30px;
        color: #333333;
        line-height: 1.6;
        font-size: 16px;
      }
      .otp-box {
        background-color: #f4f8fe;
        border: 2px dashed #1a73e8;
        border-radius: 8px;
        padding: 20px;
        text-align: center;
        margin: 25px 0;
      }
      .otp-code {
        font-size: 32px;
        font-weight: bold;
        letter-spacing: 5px;
        color: #1a73e8;
      }
      .footer {
        background-color: #f1f1f1;
        color: #888888;
        font-size: 12px;
        text-align: center;
        padding: 15px;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <h2 style="margin: 0;">Talkmart</h2>
      </div>
      <div class="content">
        <p>Salam,</p>
        <p>Sizin <b>${title.toLowerCase()}</b> üçün tələb etdiyiniz birdəfəlik şifrə (OTP) aşağıdadır:</p>
        
        <div class="otp-box">
          <div class="otp-code">${code}</div>
        </div>
        
        <p>Bu kod <b>10 dəqiqə</b> ərzində etibarlıdır. Təhlükəsizliyiniz üçün zəhmət olmasa, kodu heç kimlə paylaşmayın.</p>
        <p>Əgər bu sorğunu siz etməmisinizsə, narahat olmayın və bu məktubu görməzdən gəlin.</p>
      </div>
      <div class="footer">
        <p>© ${new Date().getFullYear()} Talkmart. Bütün hüquqlar qorunur.</p>
      </div>
    </div>
  </body>
  </html>
  `;

  await transporter.sendMail({
    from,
    to,
    subject: `Talkmart — ${title}`,
    text: `Salam,\n\nSizin ${title.toLowerCase()} üçün tələb etdiyiniz birdəfəlik şifrə (OTP): ${code}\n\nBu kod 10 dəqiqə ərzində etibarlıdır. Təhlükəsizliyiniz üçün zəhmət olmasa, kodu heç kimlə paylaşmayın.\n\n© ${new Date().getFullYear()} Talkmart`,
    html: htmlTemplate,
  });
}

export async function sendAdminNotification(subject, text) {
  const from = process.env.FROM_EMAIL || process.env.SMTP_USER;
  const to = process.env.ADMIN_EMAIL || process.env.SMTP_USER;
  try {
    await transporter.sendMail({
      from,
      to,
      subject: `Talkmart Admin Alert: ${subject}`,
      text,
    });
  } catch (err) {
    console.error("Failed to send admin notification:", err);
  }
}
