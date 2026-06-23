import mongoose from "mongoose";

const OtpSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    purpose: { type: String, required: true }, // "register" | "login" | "email_change"
    otpHash: { type: String, required: true },
    newEmail: { type: String, lowercase: true, trim: true }, // Yeni email-i saxlamaq üçün
    expiresAt: { type: Date, required: true },
    attemptsLeft: { type: Number, default: 5 },
    lastSentAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

// vaxt bitəndə özü silinsin
OtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// hər email+purpose üçün 1 OTP
OtpSchema.index({ email: 1, purpose: 1 }, { unique: true });

export default mongoose.models.Otp || mongoose.model("Otp", OtpSchema);
