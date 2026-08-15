import { Router } from "express";
import {
  initiateUpload,
  completeUpload,
  cancelUpload,
  retryStage,
  getPlay,
  listVideos,
  askVideo,
} from "../controllers/video.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";

const router = Router();

router.use(requireAuth);

router.get("/get-videos", listVideos);

router.post("/initiate-upload", initiateUpload);

router.post("/:videoId/complete-upload", completeUpload);

router.post("/:videoId/cancel-upload", cancelUpload);

router.post("/:videoId/retry/:stage", retryStage);

router.get("/:videoId/play", getPlay);

router.post("/:videoId/ask", askVideo);

export default router;
