import { Router } from "express";
import { getOnboardings, getActiveCategories } from "../controllers/public.controller.js";

const router = Router();

// GET /api/onboarding
router.get("/onboarding", getOnboardings);

// GET /api/categories
router.get("/categories", getActiveCategories);

export default router;
