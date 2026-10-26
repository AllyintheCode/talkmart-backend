import mongoose from "mongoose";
const schema = new mongoose.Schema({ _id: String, version: { type: Number, default: 0 } });
export default mongoose.models.ContentVersion || mongoose.model("ContentVersion", schema);
