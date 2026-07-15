import { Router } from "express";
import {
  initiateUpload,
  completeUpload,
  getPlay,
  listVideos,
  askVideo,
} from "../controllers/video.controller.js";

const router = Router();

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
