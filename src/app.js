import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import { globalLimiter } from "./middlewares/rateLimit.middleware.js";
import mongoSanitize from "express-mongo-sanitize";
import "dotenv/config";
import { apiContract, validateQuery, errorHandler } from "./middlewares/api.middleware.js";
import "./config/redis.js";
import authRoutes from "./routes/auth.routes.js";
import videoRoutes from "./routes/video.routes.js";
import userRoutes from "./routes/user.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import publicRoutes from "./routes/public.routes.js";
import swaggerUi from "swagger-ui-express";
import swaggerDocument from "./swagger.js";

const app = express();

// Trust proxy ayarı - rate-limit arxasında IP-ləri düzgün oxumaq üçün
app.set("trust proxy", process.env.TRUST_PROXY ? process.env.TRUST_PROXY.split(",").map((value) => value.trim()) : false);
app.use(apiContract);

// GZIP Compression — JSON cavablarını ~70% kiçildir
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

// Global Rate Limiter — Bütün API-ləri bot/DDoS hücumlarından qoruyur (TM-007)
app.use("/api", globalLimiter);

// CORS
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
      : "*",
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
  }),
);

// NoSQL Injection Qoruması (express-mongo-sanitize)
app.use(express.json({ limit: "10kb" }));
// Express 5 exposes query as a getter; sanitize values without assigning req.query.
app.use((req, res, next) => {
  for (const value of [req.body, req.params]) if (value) mongoSanitize.sanitize(value);
  next();
});
app.use("/api", validateQuery);



// Health Check Endpoint (Monitoring & uptime üçün)
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

// Public (Unrestricted) Routes
app.use("/api", publicRoutes);

// General Business Routes
app.use("/api/auth", authRoutes);
app.use("/api/videos", videoRoutes);
app.use("/api/users", userRoutes);

// Admin Control Panel
app.use("/api/admin", adminRoutes);

// Swagger API Docs
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

app.use((req, res) => res.status(404).json({ error: "NOT_FOUND", message: "Route not found" }));
app.use(errorHandler);
export default app;
