import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import "dotenv/config";
import { connectDB } from "./config/db.js";
import authRoutes from "./routes/auth.routes.js";
import videoRoutes from "./routes/video.routes.js";
import userRoutes from "./routes/user.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import publicRoutes from "./routes/public.routes.js";
import swaggerUi from "swagger-ui-express";
import swaggerDocument from "./swagger.js";

const app = express();

// ✅ GZIP Compression — JSON response-ları ~70% kiçildir
app.use(compression());

// Global Security Headers
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "script-src": ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
        "style-src": ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
        "img-src": ["'self'", "data:", "https://res.cloudinary.com"],
      },
    },
  })
);

// ✅ Global Rate Limiter — Bütün API-ləri bot/DDoS hücumlarından qoruyur
const globalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 dəqiqə
  max: 200,                  // IP-ə 200 sorğu/dəqiqə
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Çox sorğu göndərdiniz. Bir az gözləyin." },
});
app.use("/api", globalLimiter);

// CORS — Production-da öz domenini yaz
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",")
    : "*",
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.use(express.json({ limit: "10kb" })); // ✅ JSON body limit — memory overflow qorunması

// Public (Unrestricted) Routes
app.use("/api", publicRoutes);

// General Business Routes
app.use("/api/auth", authRoutes);
app.use("/api/videos", videoRoutes);
app.use("/api/users", userRoutes);

// Admin Control Panel
app.use("/api/admin", adminRoutes);

// Swagger API Docs (Vercel Fix with CDNs)
const CSS_URL = "https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/4.1.0/swagger-ui.min.css";
app.use(
  "/api-docs",
  swaggerUi.serve,
  swaggerUi.setup(swaggerDocument, {
    customCssUrl: CSS_URL,
    customJs: [
      "https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/4.1.0/swagger-ui-bundle.min.js",
      "https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/4.1.0/swagger-ui-standalone-preset.min.js",
    ],
  })
);

const PORT = process.env.PORT || 5000;

// ✅ JWT_SECRET güc yoxlaması — zəif key ilə server başlamasın
const JWT_SECRET = process.env.JWT_SECRET || "";
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error("❌ FATAL: JWT_SECRET .env-də yoxdur və ya çox qısadır (min 32 simvol). Server dayandırıldı.");
  process.exit(1);
}

connectDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 Server: http://localhost:${PORT}`));
});
export default app;