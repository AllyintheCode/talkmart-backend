import mongoose from "mongoose";

const OnboardingSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      required: true,
      trim: true,
    },
    image: {
      type: String,
      required: true, // R2 public URL saxlayacağıq
    },
    publicId: {
      type: String,
      required: true, // Şəkili silmək və ya yeniləmək üçün public_id
    },
    order: {
      type: Number,
      required: true, // Ekranın göstərilmə ardıcıllığı
      default: 0,
    },
  },
  { timestamps: true }
);

export default mongoose.models.Onboarding || mongoose.model("Onboarding", OnboardingSchema);
