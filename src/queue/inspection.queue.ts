import { Queue } from "bullmq";
import { redisConnection } from "../config/redis.js";
import { defaultJobOptions } from "./options.js";

export const INSPECTION_QUEUE = "inspection";

export const inspectionQueue = new Queue(INSPECTION_QUEUE, {
  connection: redisConnection,
  defaultJobOptions,
});
