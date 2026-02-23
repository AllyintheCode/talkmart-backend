import User from "../models/User.js";
import { z } from "zod";
import { signAccessToken } from "../utils/jwt.js";
import { sendSms } from "../services/sms/index.js";
import { normalizeAzPhone } from "../utils/phone.js";

// ✅ phone formatını özünə görə dəqiqləşdirə bilərik
const sendOtpSchema = z.object({
  phone: z.string().min(7, "Phone minimum 7 simvol olmalıdır"),
});

const verifyOtpSchema = z.object({
  phone: z.string().min(7),
  code: z.string().length(4, "Kod 4 rəqəm olmalıdır"),

  // ilk dəfə verify edəndə profil məlumatları gələ bilər
  role: z.enum(["user", "provider"]).optional(),

  // user/provider ortaq
  fullName: z.string().min(2).optional(),

  // provider üçün
  companyName: z.string().min(2).optional(),
  primaryServices: z.array(z.string()).optional(),
  location: z.string().min(2).optional(),
  about: z.string().min(10).optional(),
});

// OTP generator (4 rəqəm)
function generateOtp() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

export async function sendOtp(req, res) {
  const parsed = sendOtpSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: "Validation error" });
  }

  const rawPhone = parsed.data.phone;
  const phone = normalizeAzPhone(rawPhone);

  const code = generateOtp();
  const expire = new Date(Date.now() + 5 * 60 * 1000);

  await User.findOneAndUpdate(
    { phone },
    { otpCode: code, otpExpire: expire },
    { upsert: true, returnDocument: "after" },
  );

  await sendSms({
    to: phone,
    text: `Talkmart OTP kodunuz: ${code}`,
  });

  return res.json({ message: "OTP göndərildi" });
}

export async function verifyOtp(req, res) {
  const parsed = verifyOtpSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Validation error", details: parsed.error.issues });
  }

  const {
    phone,
    code,
    role,
    fullName,
    companyName,
    primaryServices,
    location,
    about,
  } = parsed.data;

  const user = await User.findOne({ phone });
  if (!user)
    return res.status(400).json({ error: "OTP tapılmadı, əvvəl send-otp et" });

  // OTP check
  if (!user.otpCode || !user.otpExpire) {
    return res
      .status(400)
      .json({ error: "OTP mövcud deyil, yenidən send-otp et" });
  }

  if (user.otpExpire < new Date()) {
    return res
      .status(400)
      .json({ error: "OTP vaxtı bitib, yenidən send-otp et" });
  }

  if (user.otpCode !== code) {
    return res.status(400).json({ error: "OTP yanlışdır" });
  }

  // Profil update (ilk dəfə gələndə yazırıq, istəyirsən həmişə update edək)
  if (fullName && !user.fullName) user.fullName = fullName;

  // role dəyişməsi: təhlükəsiz üçün yalnız boşdursa yazırıq
  if (role && user.role === "user") user.role = role;

  if (user.role === "provider") {
    user.providerProfile = user.providerProfile || {};

    // provider məlumatlarını yazırıq (gələn varsa)
    if (companyName) user.providerProfile.companyName = companyName;
    if (primaryServices) user.providerProfile.primaryServices = primaryServices;
    if (location) user.providerProfile.location = location;
    if (about) user.providerProfile.about = about;

    // verified default false qalır
    if (typeof user.providerProfile.verified !== "boolean") {
      user.providerProfile.verified = false;
    }
  }

  // OTP sil
  user.otpCode = null;
  user.otpExpire = null;

  await user.save();

  const token = signAccessToken({ id: user._id.toString(), role: user.role });

  return res.json({
    message: "Giriş uğurlu",
    token,
    user: {
      id: user._id,
      fullName: user.fullName,
      phone: user.phone,
      role: user.role,
      providerProfile:
        user.role === "provider" ? user.providerProfile : undefined,
    },
  });
}
