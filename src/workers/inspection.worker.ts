/**
 * Inspection worker — the pipeline's entry stage.
 *
 * Consumes "inspect-video" jobs: downloads the original from MinIO, probes it
 * with ffprobe, saves the metadata, and marks the video "inspected". Then fans
 * out in parallel to the planner (→ transcoding), thumbnail, and transcript
 * stages.
 *
 * Marks the video "failed" (stage "inspection") only once BullMQ retries are
 * exhausted, so a transient blip doesn't prematurely fail it. Runs as its own
 * process (see package.json `worker:inspection`).
 */
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
        progress: computeOverallProgress("inspecting"),
        "stageTimestamps.inspectionStartedAt": new Date(),
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
        {
          metadata,
          status: "inspected",
          progress: computeOverallProgress("inspected"),
          "stageTimestamps.inspectionCompletedAt": new Date(),
        },
        { returnDocument: "after" }
      );

      console.log("Inspected video:", JSON.stringify(video, null, 2));

      // metadata is ready — fan out to planner (pipeline) and thumbnail
      // (independent, non-blocking) in parallel.
      await Promise.all([
        plannerQueue.add("plan-video", { videoId }),
        thumbnailQueue.add("generate-thumbnail", { videoId }),
        transcriptQueue.add("transcribe-video", { videoId }),
      ]);
    } catch (err) {
      // Only mark the video "failed" once retries are exhausted; earlier
      // attempts will be retried by BullMQ after a backoff.
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
      // remove the whole per-video temp folder (no-op if it was never created)
      await fs.promises.rm(workDir, { recursive: true, force: true });
    }
  },
  { connection: redisConnection }
);

// drain the in-flight job and release connections on SIGINT/SIGTERM
registerGracefulShutdown({ worker: inspectionWorker, queues: [plannerQueue, thumbnailQueue, transcriptQueue] });

export default inspectionWorker;
