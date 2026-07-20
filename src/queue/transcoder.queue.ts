/**
 * Transcoder queue — carries "transcode-video" jobs (encode HLS renditions).
 *
 * Producer: the planner worker. Consumer: the transcoder worker (the last hard
 * step; it marks the video "completed").
 */
import { Queue } from "bullmq";
import { redisConnection } from "../config/redis.js";
import { defaultJobOptions } from "../config/queueconfig.js";

export const TRANSCODER_QUEUE = "transcoder";

export const transcoderQueue = new Queue(TRANSCODER_QUEUE, {
  connection: redisConnection,
  defaultJobOptions,
});
