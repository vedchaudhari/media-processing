import { VIDEO_BUCKET } from "../config/minio.js";
import {
  createBucket,
  setHlsPublicReadPolicy,
} from "../services/storage.service.js";

/**
 * Ensures all MinIO buckets the app depends on exist and that HLS outputs are
 * publicly readable for direct playback (originals stay private).
 */
const initStorage = async (): Promise<void> => {
  await createBucket(VIDEO_BUCKET);
  await setHlsPublicReadPolicy(VIDEO_BUCKET);
  console.log(`Storage ready: bucket "${VIDEO_BUCKET}" ensured (hls/ public-read)`);
};

/**
 * Runs all one-time startup tasks required before the app begins serving
 * requests or processing jobs. Add new initialization steps here as the app
 * grows (e.g. seeding data, warming caches, registering schedules).
 */
export const runStartupTasks = async (): Promise<void> => {
  await initStorage();
};
