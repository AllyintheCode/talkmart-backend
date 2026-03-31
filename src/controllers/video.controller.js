import Video from "../models/Video.js";
import cloudinary from "../config/cloudinary.js";

// POST /api/videos/upload
export const createVideo = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "MISSING_FILE", message: "Video fayl tələb olunur." });
    }

    const { description, price, title, categoryId } = req.body;

    if (!categoryId) {
      // Əgər file Cloudinary-yə artıq yüklənibsə və validasiya keçmədisə, onu silə bilərik, amma multer limitsiz buraxır hələlik.
      // Profilaktik olaraq ən pisi zibillik saxlayacaq publicId ilə.
      return res.status(400).json({ error: "MISSING_CATEGORY", message: "Kateqoriya seçimi tələb olunur." });
    }

    if (!description || description.trim() === "") {
      return res.status(400).json({ error: "MISSING_DESCRIPTION", message: "Açıqlama tələb olunur." });
    }

    if (price === undefined || price === null || price === "") {
      return res.status(400).json({ error: "MISSING_PRICE", message: "Qiymət tələb olunur." });
    }

    const parsedPrice = parseFloat(price);
    if (isNaN(parsedPrice) || parsedPrice < 0) {
      return res.status(400).json({ error: "INVALID_PRICE", message: "Qiymət düzgün deyil." });
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
      categoryId,
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
    // Cloudinary və ya digər infrastruktur xətaları
    if (err.name === "TimeoutError" || err.message.includes("timeout")) {
      return res.status(408).json({ error: "NETWORK_ERROR", message: "Bağlantı zaman aşımına uğradı." });
    }
    return res.status(500).json({ error: "SERVER_ERROR", message: "Server xətası baş verdi. Zəhmət olmasa yenidən cəhd edin." });
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

// ============================
// PUBLIC / EXPLORE FEED ROUTES
// ============================

// GET /api/videos/feed
// Home (Reels) Məntiqi: Formatlandıırılmış təsadüfi axın (Yalnız status="active")
export const getFeedVideos = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    
    // Yalnız aktiv videoları təsadüfi $sample ilə seçirik. 
    // Hər pagedə TikTok tərzi fərqli videolar göndərir.
    const videos = await Video.aggregate([
      { $match: { status: "active" } },
      { $sample: { size: limit } },
      {
        $lookup: {
          from: "users",
          localField: "providerId",
          foreignField: "_id",
          as: "provider",
        },
      },
      { $unwind: "$provider" },
      {
        $project: {
          _id: 1,
          title: 1,
          description: 1,
          price: 1,
          videoUrl: 1,
          thumbnail: 1,
          categoryId: 1,
          likeCount: 1,
          viewCount: 1,
          saveCount: 1,
          createdAt: 1,
          providerId: "$provider._id",
          "provider.fullName": "$provider.fullName",
          "provider.companyName": "$provider.providerProfile.companyName",
        },
      },
    ]);

    return res.status(200).json({ success: true, count: videos.length, videos });
  } catch (err) {
    console.error("getFeedVideos error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Server xətası." });
  }
};

// GET /api/videos/explore
// Explore (Axtarış / Filtrləmə) Məntiqi: Səhifələmə (Pagination), Kateqoriya filteri
export const getExploreVideos = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 15;
    const skip = (page - 1) * limit;

    const { categoryId, search, sort } = req.query;

    const query = { status: "active" };

    if (categoryId) {
      query.categoryId = categoryId;
    }

    if (search) {
      // Regex ilə həm başlıq, həm də açıqlama daxilində eyni anda axtarış var:
      const searchRegex = new RegExp(search, "i");
      query.$or = [{ title: searchRegex }, { description: searchRegex }];
    }

    let sortOption = { createdAt: -1 }; // default: ən yenilər
    if (sort === "trending") sortOption = { viewCount: -1, likeCount: -1 };
    else if (sort === "price_low") sortOption = { price: 1 };
    else if (sort === "price_high") sortOption = { price: -1 };

    const videos = await Video.find(query)
      .sort(sortOption)
      .skip(skip)
      .limit(limit)
      .populate("providerId", "fullName providerProfile.companyName") 
      .select("-publicId");

    const total = await Video.countDocuments(query);

    return res.status(200).json({
      success: true,
      count: videos.length,
      total,
      page,
      totalPages: Math.ceil(total / limit),
      videos,
    });
  } catch (err) {
    console.error("getExploreVideos error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Server xətası." });
  }
};

