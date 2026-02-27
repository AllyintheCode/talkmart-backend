import mongoose from "mongoose";

const ProviderProfileSchema = new mongoose.Schema(
  {
    companyName: { type: String, trim: true },
    primaryServices: [{ type: String, trim: true }],
    location: { type: String, trim: true },
    about: { type: String, trim: true },
    verified: { type: Boolean, default: false },
  },
  { _id: false },
);

const UserSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ["user", "provider", "admin"], required: true },

    fullName: { type: String, required: true, trim: true },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    phone: { type: String, required: true, unique: true, trim: true },

    providerProfile: { type: ProviderProfileSchema, default: null },
  },
  { timestamps: true },
);

export default mongoose.models.User || mongoose.model("User", UserSchema);
