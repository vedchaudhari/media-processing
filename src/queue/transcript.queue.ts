import { Queue } from "bullmq";
import { redisConnection } from "../config/redis.js";
import { defaultJobOptions } from "../config/queueconfig.js";
import type { TranscribeVideoJob } from "./types.js";

export const TRANSCRIPT_QUEUE = "transcript";

export const transcriptQueue = new Queue<TranscribeVideoJob>(TRANSCRIPT_QUEUE, {
  connection: redisConnection,
  defaultJobOptions,
});
