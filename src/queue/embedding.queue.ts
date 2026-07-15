import { Queue } from "bullmq";
import { redisConnection } from "../config/redis.js";
import { defaultJobOptions } from "../config/queueconfig.js";

export const EMBEDDING_QUEUE = "embeddings";

export const embeddingQueue = new Queue(EMBEDDING_QUEUE, {
  connection: redisConnection,
  defaultJobOptions,
});
