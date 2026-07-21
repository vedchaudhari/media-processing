/**
 * Auth routes, mounted at /api/auth.
 */
import { Router } from "express";
import { register, login, getMe } from "../controllers/auth.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";

const router = Router();

router.post("/register", register);
router.post("/login", login);
router.get("/me", requireAuth, getMe);

export default router;
