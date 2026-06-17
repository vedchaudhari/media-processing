import * as dotenv from "dotenv";

// Load environment variables ONCE, here, before anything reads them.
// Every other module imports `env` from this file instead of touching
// process.env directly — so importing them guarantees dotenv has run.
dotenv.config();

export const env = {
  port: Number(process.env.PORT) || 3000,
  mongoUri: process.env.MONGO_URI ?? "mongodb://localhost:27017/media-processing",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  minio: {
    endPoint: process.env.MINIO_ENDPOINT || "localhost",
    port: Number(process.env.MINIO_PORT) || 9000,
    accessKey: process.env.MINIO_ACCESS_KEY || "minioadmin",
    secretKey: process.env.MINIO_SECRET_KEY || "minioadmin",
    bucket: process.env.MINIO_BUCKET || "videos",
  },
} as const;
