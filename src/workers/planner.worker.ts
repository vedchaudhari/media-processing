/**
 * Planner worker — decides the transcode ladder.
 *
 * Consumes "plan-video" jobs: reads the inspected metadata, computes the
 * rendition variants (planVariants), saves them, marks the video "planned", and
 * enqueues transcoding. Requires inspection to have run first (needs
 * metadata.height).
 *
 * Marks the video "failed" (stage "planning") on error. Runs as its own process.
 */
import { Worker, type Job } from "bullmq";
import { redisConnection } from "../config/redis.js";
import { PLANNER_QUEUE } from "../queue/planner.queue.js";
import { transcoderQueue } from "../queue/transcoder.queue.js";
import { connectDB } from "../config/db.js";
import { registerGracefulShutdown } from "../config/shutdown.js";
import { planVariants } from "../services/planner.service.js";
import { computeOverallProgress } from "../services/progress.service.js";
import Video from "../models/video.model.js";

await connectDB();

const plannerWorker = new Worker(
  PLANNER_QUEUE,
  async (job: Job) => {
    const { videoId } = job.data;
    console.log(`Planning... videoId: ${videoId}`);

    try {
      // clear any failure context from a previous attempt (retries reuse the doc)
      const video = await Video.findByIdAndUpdate(
        videoId,
        {
          status: "planning",
          progress: computeOverallProgress("planning"),
          $unset: { failedStage: "", error: "", failedAt: "" },
        },
        { returnDocument: "after" }
      );

      if (!video) {
        throw new Error(`Video not found: ${videoId}`);
      }

      if (!video.metadata?.height) {
        throw new Error(
          `Video ${videoId} has no metadata yet — inspection must run first`
        );
      }

      const variants = planVariants(video.metadata);

      const planned = await Video.findByIdAndUpdate(
        videoId,
        {
          variants,
          status: "planned",
          progress: computeOverallProgress("planned"),
          "stageTimestamps.planningCompletedAt": new Date(),
        },
        { returnDocument: "after" }
      );

      console.log("Planned video:", JSON.stringify(planned, null, 2));

      // plan is ready, so hand off to the transcoder
      await transcoderQueue.add("transcode-video", { videoId });
    } catch (err) {
      // Only mark the video "failed" once retries are exhausted; earlier
      // attempts will be retried by BullMQ after a backoff.
      const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (isFinalAttempt) {
        await Video.findByIdAndUpdate(videoId, {
          status: "failed",
          failedStage: "planning",
          error: err instanceof Error ? err.message : String(err),
          failedAt: new Date(),
        });
      }
      throw err; // let BullMQ record the job as failed (and retry if attempts remain)
    }
  },
  { connection: redisConnection }
);

// drain the in-flight job and release connections on SIGINT/SIGTERM
registerGracefulShutdown({ worker: plannerWorker, queues: [transcoderQueue] });

export default plannerWorker;
