import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Worker, type Job } from "bullmq";
import { redisConnection } from "../config/redis.js";
import { INSPECTION_QUEUE } from "../queue/inspection.queue.js";
import { plannerQueue } from "../queue/planner.queue.js";
import { thumbnailQueue } from "../queue/thumbnail.queue.js";
import { transcriptQueue } from "../queue/transcript.queue.js";
import { connectDB } from "../config/db.js";
import { registerGracefulShutdown } from "../config/shutdown.js";
import { downloadObject } from "../services/storage.service.js";
import { inspectVideo } from "../services/ffprobe.service.js";
import { computeOverallProgress } from "../services/progress.service.js";
import { VIDEO_BUCKET } from "../config/minio.js";
import Video from "../models/video.model.js";
import type { InspectVideoJob } from "../queue/types.js";

await connectDB();

const inspectionWorker = new Worker(
  INSPECTION_QUEUE,
  async (job: Job<InspectVideoJob>) => {
    const { videoId, objectKey } = job.data;
    const workDir = path.join(os.tmpdir(), videoId);
    const localPath = path.join(workDir, "original.mp4");

    console.log(`Inspecting... videoId: ${videoId}`);

    try {

      await Video.findByIdAndUpdate(videoId, {
        status: "inspecting",
        progress: computeOverallProgress("inspecting"),
        "stageTimestamps.inspectionStartedAt": new Date(),
        $unset: { failedStage: "", error: "", failedAt: "" },
      });

      await fs.promises.mkdir(workDir, { recursive: true });

      await downloadObject(VIDEO_BUCKET, objectKey, localPath);

      const { size } = await fs.promises.stat(localPath);
      console.log(`Downloaded to ${localPath} (${size} bytes)`);

      const metadata = await inspectVideo(localPath);

      const video = await Video.findByIdAndUpdate(
        videoId,
        {
          metadata,
          status: "inspected",
          progress: computeOverallProgress("inspected"),
          "stageTimestamps.inspectionCompletedAt": new Date(),
        },
        { returnDocument: "after" }
      );

      console.log("Inspected video:", JSON.stringify(video, null, 2));

      await Promise.all([
        plannerQueue.add("plan-video", { videoId }),
        thumbnailQueue.add("generate-thumbnail", { videoId }),
        transcriptQueue.add("transcribe-video", { videoId }),
      ]);
    } catch (err) {

      const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (isFinalAttempt) {
        await Video.findByIdAndUpdate(videoId, {
          status: "failed",
          failedStage: "inspection",
          error: err instanceof Error ? err.message : String(err),
          failedAt: new Date(),
        });
      }
      throw err;
    } finally {

      await fs.promises.rm(workDir, { recursive: true, force: true });
    }
  },
  { connection: redisConnection }
);

registerGracefulShutdown({ worker: inspectionWorker, queues: [plannerQueue, thumbnailQueue, transcriptQueue] });

export default inspectionWorker;
