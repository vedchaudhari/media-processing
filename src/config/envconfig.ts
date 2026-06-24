import * as dotenv from "dotenv";
import { detectEncoder } from "./encoder.js";

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
  transcode: {
    // FFmpeg H.264 video encoder. When VIDEO_ENCODER is unset we auto-detect
    // the best available encoder (h264_nvenc → h264_videotoolbox → libx264),
    // so the same code runs on an NVIDIA box, a Mac, or a plain CPU host. Set
    // VIDEO_ENCODER explicitly to force a specific encoder.
    videoEncoder: process.env.VIDEO_ENCODER || detectEncoder(),
    // Max number of variants to transcode at once within a single job. Capped
    // because (a) consumer NVIDIA GPUs limit simultaneous NVENC sessions and
    // (b) software encoding saturates the CPU. 2 is a safe default for both;
    // raise it on a beefy box / data-center GPU via TRANSCODE_CONCURRENCY.
    concurrency: Math.max(1, Number(process.env.TRANSCODE_CONCURRENCY) || 2),
    // Max number of videos (BullMQ jobs) the transcoder worker processes at
    // once. Default 1 means a big video blocks smaller ones queued behind it.
    // Raise via TRANSCODE_JOB_CONCURRENCY to transcode multiple videos in
    // parallel. Note: total concurrent FFmpeg processes ≈ jobConcurrency ×
    // concurrency, so size both against your CPU/GPU (and NVENC session limits).
    jobConcurrency: Math.max(
      1,
      Number(process.env.TRANSCODE_JOB_CONCURRENCY) || 2
    ),
  },
} as const;
