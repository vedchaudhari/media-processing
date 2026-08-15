import { Queue } from "bullmq";
import { redisConnection } from "../config/redis.js";
import { defaultJobOptions } from "../config/queueconfig.js";
import type { GenerateEmbeddingsJob } from "./types.js";

export const EMBEDDING_QUEUE = "embeddings";

export const embeddingQueue = new Queue<GenerateEmbeddingsJob>(EMBEDDING_QUEUE, {
  connection: redisConnection,
  defaultJobOptions,
});
