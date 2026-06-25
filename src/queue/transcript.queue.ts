import { Queue } from "bullmq";
import { redisConnection } from "../config/redis.js";
import { defaultJobOptions } from "../config/queueconfig.js";

export const TRANSCRIPT_QUEUE = "transcript";

export const transcriptQueue = new Queue(TRANSCRIPT_QUEUE, {
  connection: redisConnection,
  defaultJobOptions,
});
