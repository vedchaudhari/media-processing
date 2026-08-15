import { VIDEO_BUCKET } from "../config/minio.js";
import {
  createBucket,
  setPublicReadPolicy,
} from "../services/storage.service.js";
import Video from "../models/video.model.js";

const initStorage = async (): Promise<void> => {
  await createBucket(VIDEO_BUCKET);
  await setPublicReadPolicy(VIDEO_BUCKET);
  console.log(`Storage ready: bucket "${VIDEO_BUCKET}" ensured (hls/ + thumbnails public-read)`);
};

const STALE_UPLOAD_MS = 60 * 60 * 1000;

const failStaleUploads = async (): Promise<void> => {
  const cutoff = new Date(Date.now() - STALE_UPLOAD_MS);
  const result = await Video.updateMany(
    { status: "uploading", createdAt: { $lt: cutoff } },
    {
      status: "failed",
      failedStage: "upload",
      error: "Upload was never completed (presigned URL expired)",
      failedAt: new Date(),
    }
  );
  if (result.modifiedCount > 0) {
    console.log(`Marked ${result.modifiedCount} stale upload(s) as failed`);
  }
};

export const runStartupTasks = async (): Promise<void> => {
  await initStorage();
  await failStaleUploads();

  setInterval(() => {
    failStaleUploads().catch((err) =>
      console.error("Stale-upload sweep failed:", err)
    );
  }, STALE_UPLOAD_MS).unref();
};
