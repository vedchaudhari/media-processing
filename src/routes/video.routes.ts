/**
 * Video API routes, mounted at /api/videos.
 *
 * The public, user-facing surface: the upload handshake (initiate/complete),
 * listing, playback info, and Ask-AI. Thin layer — each route delegates
 * straight to a controller.
 */
import { Router } from "express";
import {
  initiateUpload,
  completeUpload,
  getPlay,
  listVideos,
  askVideo,
} from "../controllers/video.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";

const router = Router();

// every video route requires a logged-in user; ownership is enforced per-route
// in the controller (see canAccessVideo in video.controller.ts)
router.use(requireAuth);

// GET /videos/get-videos
router.get("/get-videos", listVideos);

// POST /videos/initiate-upload
router.post("/initiate-upload", initiateUpload);

// POST /videos/:videoId/complete-upload
router.post("/:videoId/complete-upload", completeUpload);

// GET /videos/:videoId/play
router.get("/:videoId/play", getPlay);

// POST /videos/:videoId/ask
router.post("/:videoId/ask", askVideo);

export default router;
