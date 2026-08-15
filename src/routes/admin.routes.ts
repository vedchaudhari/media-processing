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

router.get("/stats/stream", streamStats);
router.get("/videos", listAllVideos);
router.get("/users", listUsers);

export default router;
