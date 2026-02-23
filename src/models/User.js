import mongoose from "mongoose";

const UserSchema = new mongoose.Schema(
  {
    fullName: { type: String, trim: true },
    phone: { type: String, required: true, unique: true },

    role: { type: String, enum: ["user", "provider", "admin"], default: "user" },

    providerProfile: {
      companyName: String,
      primaryServices: [String],
      location: String,
      about: String,
      verified: { type: Boolean, default: false },
    },

    otpCode: String,
    otpExpire: Date,
  },
  { timestamps: true }
);

export default mongoose.models.User || mongoose.model("User", UserSchema);
