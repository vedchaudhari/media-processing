/**
 * Planner queue — carries "plan-video" jobs (decide the transcode ladder).
 *
 * Producer: the inspection worker. Consumer: the planner worker, which then
 * enqueues transcoding.
 */
import { Queue } from "bullmq";
import { redisConnection } from "../config/redis.js";
import { defaultJobOptions } from "../config/queueconfig.js";

export const PLANNER_QUEUE = "planner";

export const plannerQueue = new Queue(PLANNER_QUEUE, {
  connection: redisConnection,
  defaultJobOptions,
});
