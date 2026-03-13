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
  };
  const title = titles[purpose] || "Təsdiq kodu";

  await transporter.sendMail({
    from,
    to,
    subject: `Talkmart — ${title}`,
    text: `${title}: ${code}. Bu kod 10 dəqiqə etibarlıdır.`,
    html: `<p>${title}: <b style="font-size:18px">${code}</b></p><p>Bu kod 10 dəqiqə etibarlıdır.</p>`,
  });
}
