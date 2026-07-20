/**
 * Thumbnail queue — carries "generate-thumbnail" jobs.
 *
 * Producer: the inspection worker (fan-out). Consumer: the thumbnail worker.
 * Non-blocking side branch — a failure here never fails the video.
 */
import { Queue } from "bullmq";
import { redisConnection } from "../config/redis.js";
import { defaultJobOptions } from "../config/queueconfig.js";

export const THUMBNAIL_QUEUE = "thumbnail";

export const thumbnailQueue = new Queue(THUMBNAIL_QUEUE, {
  connection: redisConnection,
  defaultJobOptions,
});
