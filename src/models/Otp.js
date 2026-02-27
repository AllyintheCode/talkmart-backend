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
    purpose: { type: String, default: "login" }, // login
    otpHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attemptsLeft: { type: Number, default: 5 },
    lastSentAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

OtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
OtpSchema.index({ email: 1, purpose: 1 }, { unique: true });

export default mongoose.models.Otp || mongoose.model("Otp", OtpSchema);
