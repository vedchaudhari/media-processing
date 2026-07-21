/**
 * Flushes the Redis database used by BullMQ.
 *
 * Run with `npm run clear:redis`. Wipes all queue state — waiting/active/
 * delayed jobs plus the completed/failed job history that backs the admin
 * dashboard's queue-depth and failed-job counts. Development convenience for
 * clearing out stale/leftover jobs; runs immediately with no confirmation
 * (matches scripts/delete-qdrant.ts).
 *
 * Stop the API and workers first — flushing Redis out from under a running
 * worker can leave it processing a job whose state just vanished.
 */
import { Redis } from "ioredis";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function clearRedis() {
  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });

  try {
    const keyCount = await redis.dbsize();
    await redis.flushdb();
    console.log(`✅ Redis flushed: ${keyCount} keys removed (${redisUrl}).`);
  } finally {
    redis.disconnect();
  }
}

clearRedis().catch((err) => {
  console.error("✗ clear-redis failed:", err);
  process.exit(1);
});
