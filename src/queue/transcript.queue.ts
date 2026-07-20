/**
 * Transcript queue — carries "transcribe-video" jobs (speech-to-text).
 *
 * Producer: the inspection worker (fan-out). Consumer: the transcript worker,
 * which — when the video has speech — enqueues the AI-summary and embedding
 * jobs. Non-blocking side branch.
 */
import { Queue } from "bullmq";
import { redisConnection } from "../config/redis.js";
import { defaultJobOptions } from "../config/queueconfig.js";

export const TRANSCRIPT_QUEUE = "transcript";

export const transcriptQueue = new Queue(TRANSCRIPT_QUEUE, {
  connection: redisConnection,
  defaultJobOptions,
});
