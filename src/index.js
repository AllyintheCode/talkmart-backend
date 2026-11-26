import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import { identifyForRateLimit, globalLimiter } from "./middlewares/rateLimit.middleware.js";
import "dotenv/config";
import { connectDB } from "./config/db.js";
import "./config/redis.js";
import authRoutes from "./routes/auth.routes.js";
import videoRoutes from "./routes/video.routes.js";
import userRoutes from "./routes/user.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import publicRoutes from "./routes/public.routes.js";
import swaggerUi from "swagger-ui-express";
import swaggerDocument from "./swagger.js";

const app = express();

// Trust proxy — istifadəçinin real IP-sini düzgün oxumaq üçün (rate limit buna əsaslanır).
// Səhv dəyər: ya hamı eyni IP görünür (hamı birlikdə limitlənir),
// ya da hücumçu X-Forwarded-For başlığını saxtalaşdırıb IP limitlərini keçir.
// TRUST_PROXY: "false" (birbaşa internetə açıq), "1" (bir proxy: Nginx və ya Cloudflare),
//              "2" (Cloudflare → Nginx), "loopback" (yalnız eyni maşındakı Nginx-ə etibar)
const parseTrustProxy = (v) => {
  if (v === undefined || v === "") return 1;
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^\d+$/.test(v)) return parseInt(v, 10);
  return v; // "loopback", IP/subnet siyahısı və s.
};
app.set("trust proxy", parseTrustProxy(process.env.TRUST_PROXY));

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
// CORS — Production-da öz domenini yaz
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(",")
      : "*",
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

// Global Rate Limiter — login olmuşlar üçün user ID, qonaqlar üçün IP üzrə (CGNAT-a uyğun)
// Limitlər: GLOBAL_USER_RATE_LIMIT (default 300/dəq), GLOBAL_IP_RATE_LIMIT (default 1200/dəq)
app.use("/api", identifyForRateLimit, globalLimiter);

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
