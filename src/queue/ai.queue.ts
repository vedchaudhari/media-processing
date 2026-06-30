import { Queue } from "bullmq";
import { redisConnection } from "../config/redis.js";
import { defaultJobOptions } from "../config/queueconfig.js";

export const AI_QUEUE = "ai";

export const aiQueue = new Queue(AI_QUEUE, {
    connection: redisConnection,
    defaultJobOptions,
});
