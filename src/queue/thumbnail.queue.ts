import { Queue } from "bullmq";
import { redisConnection } from "../config/redis.js";
import { defaultJobOptions } from "../config/queueconfig.js";
import type { GenerateThumbnailJob } from "./types.js";

export const THUMBNAIL_QUEUE = "thumbnail";

export const thumbnailQueue = new Queue<GenerateThumbnailJob>(THUMBNAIL_QUEUE, {
  connection: redisConnection,
  defaultJobOptions,
});
