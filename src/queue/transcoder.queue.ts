import { Queue } from "bullmq";
import { redisConnection } from "../config/redis.js";
import { defaultJobOptions } from "../config/queueconfig.js";

export const TRANSCODER_QUEUE = "transcoder";

export const transcoderQueue = new Queue(TRANSCODER_QUEUE, {
  connection: redisConnection,
  defaultJobOptions,
});
