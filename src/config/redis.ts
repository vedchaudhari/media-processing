/**
 * Shared ioredis connection for the whole process.
 *
 * BullMQ queues and workers all reuse this single client, and the app's
 * /health check pings it too. Created once here and imported everywhere so we
 * never open redundant connections.
 */
import { Redis } from "ioredis";
import { env } from "./envconfig.js";

/**
 * The process-wide Redis client.
 *
 * `maxRetriesPerRequest: null` is REQUIRED by BullMQ: its workers issue
 * blocking commands (e.g. BRPOPLPUSH) that must not be aborted by ioredis's
 * default per-request retry cap, so a single connection can be shared safely
 * between queues and workers.
 */
export const redisConnection = new Redis(env.redisUrl, {
  maxRetriesPerRequest: null,
});

// Connection lifecycle logging — surfaces connect/error events so a
// misconfigured REDIS_URL or a down Redis is obvious in the logs at startup.
redisConnection.on("connect", () => {
  console.log("Redis connected");
});

redisConnection.on("error", (error) => {
  console.error("Redis connection error:", error);
});
