import * as dotenv from "dotenv";
import { detectEncoder } from "./encoder.js";
import { configureDns } from "./dns.js";

dotenv.config();

configureDns();

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

    publicUrl:
      process.env.MINIO_PUBLIC_URL || `http://${minioEndPoint}:${minioPort}`,
  },
  transcode: {

    videoEncoder: process.env.VIDEO_ENCODER || detectEncoder(),

    concurrency: Math.max(1, Number(process.env.TRANSCODE_CONCURRENCY) || 2),

    jobConcurrency: Math.max(
      1,
      Number(process.env.TRANSCODE_JOB_CONCURRENCY) || 2
    ),
  },
  ai: {
    providerType: process.env.AI_PROVIDER || (process.env.NODE_ENV === "production" ? "gemini" : "ollama"),
    openaiApiKey: process.env.OPENAI_API_KEY || "",
    openaiModel: process.env.OPENAI_MODEL || "gpt-4o-mini",
    ollamaEndpoint: process.env.OLLAMA_ENDPOINT || "http://localhost:11434",
    ollamaModel: process.env.OLLAMA_MODEL || "qwen3:4b",
    geminiApiKey: process.env.GEMINI_API_KEY || "",
    geminiModel: process.env.GEMINI_MODEL || "gemini-2.5-flash",
  },
  qdrant: {
    url: process.env.QDRANT_URL || "",
    apiKey: process.env.QDRANT_API_KEY || "",
  },
  auth: {

    jwtSecret: process.env.JWT_SECRET || "dev-only-insecure-secret-change-me",
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || "7d",

    adminEmail: (process.env.ADMIN_EMAIL || "").trim().toLowerCase(),
    adminPassword: process.env.ADMIN_PASSWORD || "",
  },
} as const;

if (process.env.NODE_ENV === "production" && !process.env.JWT_SECRET) {
  console.warn(
    "[envconfig] JWT_SECRET is not set in production — using the insecure dev default. Set JWT_SECRET in .env."
  );
}
