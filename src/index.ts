import express, { type Request, type Response } from "express";
import cors from "cors";
import mongoose from "mongoose";
import { env } from "./config/envconfig.js";
import { connectDB } from "./config/db.js";
import { redisConnection } from "./config/redis.js";
import { minioClient, VIDEO_BUCKET } from "./config/minio.js";
import { registerGracefulShutdown } from "./config/shutdown.js";
import videoRoutes from "./routes/video.routes.js";
import { inspectionQueue } from "./queue/inspection.queue.js";
import { runStartupTasks } from "./startup/index.js";

const app = express();
const PORT = env.port;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Deep health check: verify the dependencies we actually need (MongoDB, Redis,
// MinIO) rather than blindly returning OK, so a load balancer can route around
// a wedged instance. Returns 503 if any dependency is unreachable.
app.get("/health", async (_req: Request, res: Response) => {
  const checks = { mongo: false, redis: false, storage: false };

  // readyState === 1 means "connected"
  checks.mongo = mongoose.connection.readyState === 1;

  try {
    checks.redis = (await redisConnection.ping()) === "PONG";
  } catch {
    checks.redis = false;
  }

  try {
    checks.storage = await minioClient.bucketExists(VIDEO_BUCKET);
  } catch {
    checks.storage = false;
  }

  const healthy = checks.mongo && checks.redis && checks.storage;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? "okay" : "degraded",
    checks,
  });
});

// Routes
app.use("/api/videos", videoRoutes);

connectDB()
  .then(runStartupTasks)
  .then(() => {
    const server = app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });

    // close the HTTP server + the queue this process produces to on shutdown
    registerGracefulShutdown({ server, queues: [inspectionQueue] });
  });

export default app;
