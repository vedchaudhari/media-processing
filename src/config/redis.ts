import { Redis } from "ioredis";
import { env } from "./envconfig.js";

export const redisConnection = new Redis(env.redisUrl, {
  maxRetriesPerRequest: null,
});

redisConnection.on("connect", () => {
  console.log("Redis connected");
});

redisConnection.on("error", (error) => {
  console.error("Redis connection error:", error);
});
