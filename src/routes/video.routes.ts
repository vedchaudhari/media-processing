import { Router } from "express";
import { initiateUpload, completeUpload } from "../controllers/video.controller.js";

const router = Router();

// POST /videos/initiate-upload
router.post("/initiate-upload", initiateUpload);

// POST /videos/:videoId/complete-upload
router.post("/:videoId/complete-upload", completeUpload);

export default router;
