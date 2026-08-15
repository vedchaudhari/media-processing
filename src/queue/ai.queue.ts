import { Queue } from "bullmq";
import { redisConnection } from "../config/redis.js";
import { defaultJobOptions } from "../config/queueconfig.js";
import type { GenerateSummaryJob } from "./types.js";

export const AI_QUEUE = "ai";

export const aiQueue = new Queue<GenerateSummaryJob>(AI_QUEUE, {
    connection: redisConnection,
    defaultJobOptions,
});
