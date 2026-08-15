import { Queue } from "bullmq";
import { redisConnection } from "../config/redis.js";
import { defaultJobOptions } from "../config/queueconfig.js";
import type { TranscodeVideoJob } from "./types.js";

export const TRANSCODER_QUEUE = "transcoder";

export const transcoderQueue = new Queue<TranscodeVideoJob>(TRANSCODER_QUEUE, {
  connection: redisConnection,
  defaultJobOptions,
});
