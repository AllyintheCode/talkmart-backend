import Video from "../models/Video.js";
import cloudinary from "../config/cloudinary.js";

// POST /api/videos/upload
export const createVideo = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "Video fayl tələb olunur." });
    }

    const { description, price, title } = req.body;

    if (!description || description.trim() === "") {
      return res.status(400).json({ message: "Açıqlama tələb olunur." });
    }

    if (price === undefined || price === null || price === "") {
      return res.status(400).json({ message: "Qiymət tələb olunur." });
    }

    const parsedPrice = parseFloat(price);
    if (isNaN(parsedPrice) || parsedPrice < 0) {
      return res.status(400).json({ message: "Qiymət düzgün deyil." });
    }

    // Cloudinary-dən gələn URL və public_id
    const videoUrl = req.file.path;
    const publicId = req.file.filename;

    // Thumbnail URL (cloudinary eager transformation-dan)
    const thumbnail =
      req.file.eager?.[0]?.secure_url ||
      `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/video/upload/f_jpg,w_400/${publicId}.jpg`;

    const video = await Video.create({
      providerId: req.user._id,
      title: title?.trim() || "",
      description: description.trim(),
      price: parsedPrice,
      videoUrl,
      publicId,
      thumbnail,
      duration: req.file.duration || 0,
    });

    return res.status(201).json({
      success: true,
      message: "Video uğurla yükləndi.",
      video,
    });
  } catch (err) {
    console.error("createVideo error:", err);
    return res.status(500).json({ message: "Server xətası." });
  }
};

// GET /api/videos/my-videos
export const getMyVideos = async (req, res) => {
  try {
    const videos = await Video.find({ providerId: req.user._id }).sort({
      createdAt: -1,
    });

    return res.status(200).json({
      success: true,
      count: videos.length,
      videos,
    });
  } catch (err) {
    console.error("getMyVideos error:", err);
    return res.status(500).json({ message: "Server xətası." });
  }
};

// DELETE /api/videos/:id
export const deleteVideo = async (req, res) => {
  try {
    const video = await Video.findOne({
      _id: req.params.id,
      providerId: req.user._id,
    });

    if (!video) {
      return res.status(404).json({ message: "Video tapılmadı." });
    }

    // Cloudinary-dən sil
    await cloudinary.uploader.destroy(video.publicId, {
      resource_type: "video",
    });

    await video.deleteOne();

    return res.status(200).json({
      success: true,
      message: "Video silindi.",
    });
  } catch (err) {
    console.error("deleteVideo error:", err);
    return res.status(500).json({ message: "Server xətası." });
  }
};
