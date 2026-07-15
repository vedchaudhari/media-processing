import { VIDEO_BUCKET } from "../config/minio.js";
import {
  createBucket,
  setPublicReadPolicy,
} from "../services/storage.service.js";
import Video from "../models/video.model.js";

/**
 * Ensures all MinIO buckets the app depends on exist and that HLS outputs are
 * publicly readable for direct playback (originals stay private).
 */
const initStorage = async (): Promise<void> => {
  await createBucket(VIDEO_BUCKET);
  await setPublicReadPolicy(VIDEO_BUCKET);
  console.log(`Storage ready: bucket "${VIDEO_BUCKET}" ensured (hls/ + thumbnails public-read)`);
};

// The presigned PUT URL is valid for 1 hour, so any record still "uploading"
// after that can never complete — the client abandoned it. Left alone, such
// records make the library page poll forever (uploading is an in-progress
// status). Swept at startup and then hourly.
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

/**
 * Runs all one-time startup tasks required before the app begins serving
 * requests or processing jobs. Add new initialization steps here as the app
 * grows (e.g. seeding data, warming caches, registering schedules).
 */
export const runStartupTasks = async (): Promise<void> => {
  await initStorage();
  await failStaleUploads();

  // keep sweeping while the process lives; unref so it never blocks shutdown
  setInterval(() => {
    failStaleUploads().catch((err) =>
      console.error("Stale-upload sweep failed:", err)
    );
  }, STALE_UPLOAD_MS).unref();
};
