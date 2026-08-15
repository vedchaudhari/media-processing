import type { DefaultJobOptions } from "bullmq";

export const defaultJobOptions: DefaultJobOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5000 },
  removeOnComplete: 1000,
  removeOnFail: 5000,
};
