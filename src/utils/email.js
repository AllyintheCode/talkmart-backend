import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587,
  secure: false, // 587 üçün false
  requireTLS: true, // STARTTLS məcbur et
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

export async function sendEmailOtp(to, code) {
  const from = process.env.FROM_EMAIL || process.env.SMTP_USER;

  await transporter.sendMail({
    from,
    to,
    subject: "Talkmart — giriş kodu",
    text: `Giriş kodunuz: ${code}. Bu kod 10 dəqiqə etibarlıdır.`,
    html: `<p>Giriş kodunuz: <b style="font-size:18px">${code}</b></p><p>10 dəqiqə etibarlıdır.</p>`,
  });
}
