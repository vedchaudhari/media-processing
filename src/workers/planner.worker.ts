import { Worker, type Job } from "bullmq";
import { redisConnection } from "../config/redis.js";
import { PLANNER_QUEUE } from "../queue/planner.queue.js";
import { transcoderQueue } from "../queue/transcoder.queue.js";
import { connectDB } from "../config/db.js";
import { planVariants } from "../services/planner.service.js";
import Video from "../models/video.model.js";

await connectDB();

const plannerWorker = new Worker(
  PLANNER_QUEUE,
  async (job: Job) => {
    const { videoId } = job.data;
    console.log(`Planning... videoId: ${videoId}`);

    try {
      const video = await Video.findByIdAndUpdate(
        videoId,
        { status: "planning" },
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
        { variants, status: "planned" },
        { returnDocument: "after" }
      );

      console.log("Planned video:", JSON.stringify(planned, null, 2));

      // plan is ready, so hand off to the transcoder
      await transcoderQueue.add("transcode-video", { videoId });
    } catch (err) {
      await Video.findByIdAndUpdate(videoId, { status: "failed" });
      throw err; // let BullMQ record the job as failed
    }
  },
  { connection: redisConnection }
);

export default plannerWorker;
