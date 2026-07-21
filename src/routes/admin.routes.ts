/**
 * Admin API routes, mounted at /api/admin. Every route requires both a valid
 * login (requireAuth) and the admin role (requireAdmin) — no per-video
 * ownership checks here, since admins see everything by design.
 */
import { Router } from "express";
import {
  getStats,
  listAllVideos,
  listUsers,
  updateUserRole,
} from "../controllers/admin.controller.js";
import { requireAuth, requireAdmin } from "../middleware/auth.middleware.js";

const router = Router();

router.use(requireAuth, requireAdmin);

router.get("/stats", getStats);
router.get("/videos", listAllVideos);
router.get("/users", listUsers);
router.patch("/users/:userId/role", updateUserRole);

export default router;
