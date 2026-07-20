/**
 * AI queue — carries "generate-summary" jobs (LLM summary, takeaways, chapters).
 *
 * Producer: the transcript worker. Consumer: the AI worker. Non-blocking side
 * branch — a failure here never fails the video.
 */
import { Queue } from "bullmq";
import { redisConnection } from "../config/redis.js";
import { defaultJobOptions } from "../config/queueconfig.js";

export const AI_QUEUE = "ai";

export const aiQueue = new Queue(AI_QUEUE, {
    connection: redisConnection,
    defaultJobOptions,
});
