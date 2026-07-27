/**
 * Admin API routes, mounted at /api/admin. Every route requires both a valid
 * login (requireAuth) and the admin role (requireAdmin) — no per-video
 * ownership checks here, since admins see everything by design.
 */
import { Router } from "express";
import {
  getStats,
  streamStats,
  listAllVideos,
  listUsers,
} from "../controllers/admin.controller.js";
import { requireAuth, requireAdmin } from "../middleware/auth.middleware.js";

const router = Router();

router.use(requireAuth, requireAdmin);

router.get("/stats", getStats);
// Long-lived SSE stream pushing the same payload as /stats whenever it changes.
router.get("/stats/stream", streamStats);
router.get("/videos", listAllVideos);
router.get("/users", listUsers);

export default router;
