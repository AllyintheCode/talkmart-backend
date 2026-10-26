import mongoose from "mongoose";

const ProviderProfileSchema = new mongoose.Schema(
  {
    companyName:      { type: String, trim: true },
    categoryId:       { type: String, trim: true },   // Seçilmiş kateqoriya ID-si
    address:          { type: String, trim: true },   // İstifadəçinin ünvanı
    location:         { type: String, trim: true },
    website:          { type: String, trim: true },
    instagram:        { type: String, trim: true },
    whatsapp:         { type: String, trim: true },
    verified:         { type: Boolean, default: false },
  },
  { _id: false },
);

const UserSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ["guest", "user", "provider", "admin"], default: "user", required: true },

    fullName: { type: String, required: true, trim: true },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },

    phone: { type: String, required: true, unique: true, trim: true },

    password: { type: String, required: true },

    bio: { type: String, trim: true, default: null },

    // user-də null, provider-də object
    providerProfile: { type: ProviderProfileSchema, default: null },

    // Profil şəkli (R2 URL)
    profileImage: { type: String, default: null },
    profileImagePublicId: { type: String, default: null },

    // qeydiyyat OTP-si təsdiqlənibmi?
    emailVerified: { type: Boolean, default: false },

    // Admin tərəfindən bloklanıbmı?
    isBlocked: { type: Boolean, default: false },

    // Sessiya versiyası — şifrə dəyişdikdə və ya bloklandıqda artırılır və köhnə tokenlər etibarsız olur (TM-005)
    sessionVersion: { type: Number, default: 1 },
    accountStatus: { type: String, enum: ["active", "deleting"], default: "active" },
    resetTokenHash: { type: String, default: null, select: false },
    resetTokenExpiresAt: { type: Date, default: null, select: false },
    uploadReservation: { type: String, default: null, select: false },
    uploadReservedUntil: { type: Date, default: null, select: false },

    // İstifadəçinin özünün blokladığı digər istifadəçilər
    blockedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  },
  { timestamps: true },
);

UserSchema.index({ blockedUsers: 1 });
UserSchema.index({ role: 1, createdAt: -1, _id: -1 });
UserSchema.index({ accountStatus: 1 });

export default mongoose.models.User || mongoose.model("User", UserSchema);
