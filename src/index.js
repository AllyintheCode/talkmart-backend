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

// Trust proxy ayarÄ± - rate-limit arxasÄ±nda IP-lÉ™ri dÃ¼zgÃ¼n oxumaq Ã¼Ã§Ã¼n
app.set("trust proxy", 1);

// âœ… GZIP Compression â€” JSON response-larÄ± ~70% kiÃ§ildir
app.use(compression());

// Global Security Headers
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "script-src": [
          "'self'",
          "'unsafe-inline'",
          "https://cdnjs.cloudflare.com",
        ],
        "style-src": [
          "'self'",
          "'unsafe-inline'",
          "https://cdnjs.cloudflare.com",
        ],
        "img-src": [
          "'self'",
          "data:",
          "https://*.r2.dev",
          "https://*.cloudflarestorage.com",
        ],
      },
    },
  }),
);

// âœ… Global Rate Limiter â€” BÃ¼tÃ¼n API-lÉ™ri bot/DDoS hÃ¼cumlarÄ±ndan qoruyur
const globalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 dÉ™qiqÉ™
  max: 2000, // Test Ã¼Ã§Ã¼n 200-dÉ™n 2000-É™ qaldÄ±rdÄ±q
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Ã‡ox sorÄŸu gÃ¶ndÉ™rdiniz. Bir az gÃ¶zlÉ™yin.",
  },
});
// app.use("/api", globalLimiter); // GÉ™lÉ™cÉ™kdÉ™ canlÄ± mÃ¼hit Ã¼Ã§Ã¼n mÃ¼tlÉ™q geri qaytarÄ±lmalÄ±dÄ±r!

console.log("JWT", process.env.JWT_SECRET);
console.log("ENV", process.env);

// CORS â€” Production-da Ã¶z domenini yaz
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(",")
      : "*",
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use(express.json({ limit: "10kb" })); // âœ… JSON body limit â€” memory overflow qorunmasÄ±

// Public (Unrestricted) Routes
app.use("/api", publicRoutes);

// General Business Routes
app.use("/api/auth", authRoutes);
app.use("/api/videos", videoRoutes);
app.use("/api/users", userRoutes);

// Admin Control Panel
app.use("/api/admin", adminRoutes);

// Swagger API Docs (Vercel Fix with CDNs)
const CSS_URL =
  "https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/4.1.0/swagger-ui.min.css";
app.use(
  "/api-docs",
  swaggerUi.serve,
  swaggerUi.setup(swaggerDocument, {
    customCssUrl: CSS_URL,
    customJs: [
      "https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/4.1.0/swagger-ui-bundle.min.js",
      "https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/4.1.0/swagger-ui-standalone-preset.min.js",
    ],
  }),
);

const PORT = process.env.PORT || 5000;

// âœ… JWT_SECRET gÃ¼c yoxlamasÄ± â€” zÉ™if key ilÉ™ server baÅŸlamasÄ±n
const JWT_SECRET = process.env.JWT_SECRET ?? "";
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error(
    "âŒ FATAL: JWT_SECRET .env-dÉ™ yoxdur vÉ™ ya Ã§ox qÄ±sadÄ±r (min 32 simvol). Server dayandÄ±rÄ±ldÄ±.",
  );
  process.exit(1);
}

import { recoverStuckVideos } from "./services/videoProcessing.service.js";

connectDB().then(async () => {
  await recoverStuckVideos();
  app.listen(PORT, () => console.log(`ðŸš€ Server: http://localhost:${PORT}`));
});
export default app;
