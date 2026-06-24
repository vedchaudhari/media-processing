import { Queue } from "bullmq";
import { redisConnection } from "../config/redis.js";
import { defaultJobOptions } from "../config/queueconfig.js";

export const THUMBNAIL_QUEUE = "thumbnail";

export const thumbnailQueue = new Queue(THUMBNAIL_QUEUE, {
  connection: redisConnection,
  defaultJobOptions,
});
