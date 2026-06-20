import * as dotenv from "dotenv";

// Load environment variables ONCE, here, before anything reads them.
// Every other module imports `env` from this file instead of touching
// process.env directly — so importing them guarantees dotenv has run.
dotenv.config();

const minioEndPoint = process.env.MINIO_ENDPOINT || "localhost";
const minioPort = Number(process.env.MINIO_PORT) || 9000;

export const env = {
  port: Number(process.env.PORT) || 3000,
  mongoUri: process.env.MONGO_URI ?? "mongodb://localhost:27017/media-processing",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  minio: {
    endPoint: minioEndPoint,
    port: minioPort,
    accessKey: process.env.MINIO_ACCESS_KEY || "minioadmin",
    secretKey: process.env.MINIO_SECRET_KEY || "minioadmin",
    bucket: process.env.MINIO_BUCKET || "videos",
    // Base URL clients use to fetch public objects directly from MinIO.
    publicUrl:
      process.env.MINIO_PUBLIC_URL || `http://${minioEndPoint}:${minioPort}`,
  },
} as const;
