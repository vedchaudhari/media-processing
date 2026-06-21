import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Worker, type Job } from "bullmq";
import { redisConnection } from "../config/redis.js";
import { INSPECTION_QUEUE } from "../queue/inspection.queue.js";
import { plannerQueue } from "../queue/planner.queue.js";
import { connectDB } from "../config/db.js";
import { registerGracefulShutdown } from "../config/shutdown.js";
import { downloadObject } from "../services/storage.service.js";
import { inspectVideo } from "../services/ffprobe.service.js";
import { VIDEO_BUCKET } from "../config/minio.js";
import Video from "../models/video.model.js";

await connectDB();

const inspectionWorker = new Worker(
  INSPECTION_QUEUE,
  async (job: Job) => {
    const { videoId, objectKey } = job.data;
    const workDir = path.join(os.tmpdir(), videoId);
    const localPath = path.join(workDir, "original.mp4");

    console.log(`Inspecting... videoId: ${videoId}`);

    try {
      // clear any failure context from a previous attempt (retries reuse the doc)
      await Video.findByIdAndUpdate(videoId, {
        status: "inspecting",
        $unset: { failedStage: "", error: "", failedAt: "" },
      });

      // the destination directory must exist before fGetObject writes to it
      await fs.promises.mkdir(workDir, { recursive: true });

      await downloadObject(VIDEO_BUCKET, objectKey, localPath);

      // confirm the file was downloaded and saved to temp
      const { size } = await fs.promises.stat(localPath);
      console.log(`Downloaded to ${localPath} (${size} bytes)`);

      // probe the file for video/audio metadata
      const metadata = await inspectVideo(localPath);

      const video = await Video.findByIdAndUpdate(
        videoId,
        { metadata, status: "inspected" },
        { returnDocument: "after" }
      );

      console.log("Inspected video:", JSON.stringify(video, null, 2));

      // metadata is ready, so hand off to the planner
      await plannerQueue.add("plan-video", { videoId });
    } catch (err) {
      await Video.findByIdAndUpdate(videoId, {
        status: "failed",
        failedStage: "inspection",
        error: err instanceof Error ? err.message : String(err),
        failedAt: new Date(),
      });
      throw err;
    } finally {
      // remove the whole per-video temp folder (no-op if it was never created)
      await fs.promises.rm(workDir, { recursive: true, force: true });
    }
  },
  { connection: redisConnection }
);

// drain the in-flight job and release connections on SIGINT/SIGTERM
registerGracefulShutdown({ worker: inspectionWorker, queues: [plannerQueue] });

export default inspectionWorker;
