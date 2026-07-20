/**
 * Inspection queue — carries "inspect-video" jobs (probe metadata via ffprobe).
 *
 * Producer: the API's completeUpload controller (the pipeline's entry point).
 * Consumer: the inspection worker, which fans out to planner, thumbnail, and
 * transcript.
 */
import { Queue } from "bullmq";
import { redisConnection } from "../config/redis.js";
import { defaultJobOptions } from "../config/queueconfig.js";

export const INSPECTION_QUEUE = "inspection";

export const inspectionQueue = new Queue(INSPECTION_QUEUE, {
  connection: redisConnection,
  defaultJobOptions,
});
