import { Router } from "express";
import { getOnboardings, getActiveCategories, getTopCategories } from "../controllers/public.controller.js";

const router = Router();

// GET /api/onboarding
router.get("/onboarding", getOnboardings);

// GET /api/categories
router.get("/categories", getActiveCategories);

// GET /api/categories/top
router.get("/categories/top", getTopCategories);

export default router;
