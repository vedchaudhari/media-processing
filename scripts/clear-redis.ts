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
