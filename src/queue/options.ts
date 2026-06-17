import type { DefaultJobOptions } from "bullmq";

/**
 * Shared defaults for every queue.
 *
 * - attempts/backoff: retry transient failures (MinIO/Mongo/ffmpeg blips)
 *   with exponential backoff instead of failing permanently on the first error.
 * - removeOnComplete/removeOnFail: cap how many finished jobs BullMQ keeps in
 *   Redis so it doesn't grow unbounded.
 */
export const defaultJobOptions: DefaultJobOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5000 },
  removeOnComplete: 1000,
  removeOnFail: 5000,
};
