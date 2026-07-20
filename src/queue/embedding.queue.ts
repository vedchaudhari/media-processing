/**
 * Embedding queue — carries "generate-embeddings" jobs (index the transcript
 * into the Qdrant vector store for Ask-AI search).
 *
 * Producer: the transcript worker. Consumer: the embedding worker. Non-blocking
 * side branch — a failure here never fails the video.
 */
import { Queue } from "bullmq";
import { redisConnection } from "../config/redis.js";
import { defaultJobOptions } from "../config/queueconfig.js";

export const EMBEDDING_QUEUE = "embeddings";

export const embeddingQueue = new Queue(EMBEDDING_QUEUE, {
  connection: redisConnection,
  defaultJobOptions,
});
