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
  transcode: {
    // FFmpeg H.264 video encoder. Defaults to NVIDIA hardware encoding
    // (h264_nvenc) — far faster than CPU. Set VIDEO_ENCODER=libx264 to fall
    // back to software encoding on machines without an NVIDIA GPU.
    videoEncoder: process.env.VIDEO_ENCODER || "h264_nvenc",
    // Max number of variants to transcode at once within a single job. Capped
    // because (a) consumer NVIDIA GPUs limit simultaneous NVENC sessions and
    // (b) software encoding saturates the CPU. 2 is a safe default for both;
    // raise it on a beefy box / data-center GPU via TRANSCODE_CONCURRENCY.
    concurrency: Math.max(1, Number(process.env.TRANSCODE_CONCURRENCY) || 2),
  },
} as const;
