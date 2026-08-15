import { Queue } from "bullmq";
import { redisConnection } from "../config/redis.js";
import { defaultJobOptions } from "../config/queueconfig.js";
import type { InspectVideoJob } from "./types.js";

export const INSPECTION_QUEUE = "inspection";

export const inspectionQueue = new Queue<InspectVideoJob>(INSPECTION_QUEUE, {
  connection: redisConnection,
  defaultJobOptions,
});
