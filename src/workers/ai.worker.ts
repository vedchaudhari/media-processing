import { Worker, type Job } from "bullmq";
import { redisConnection } from "../config/redis.js";
import { AI_QUEUE } from "../queue/ai.queue.js";
import { connectDB } from "../config/db.js";
import { registerGracefulShutdown } from "../config/shutdown.js";
import Video from "../models/video.model.js";
import { AIService } from "../services/ai/ai.service.js";

await connectDB();

const aiWorker = new Worker(
  AI_QUEUE,
  async (job: Job) => {
    const { videoId } = job.data;
    console.log(`[AI] Processing job "${job.name}" for videoId: ${videoId}`);

    try {
      if (job.name !== "generate-summary") {
        throw new Error(`Unknown job name: ${job.name}`);
      }

      // 1. Update status to processing, clearing previous errors
      await Video.findByIdAndUpdate(videoId, {
        "aiSummary.status": "processing",
        $unset: { "aiSummary.error": "" },
      });

      const video = await Video.findById(videoId);
      if (!video) {
        throw new Error(`Video ${videoId} not found`);
      }

      const transcript = video.transcript?.text;
      if (!transcript) {
        throw new Error(`No transcript found for video ${videoId}`);
      }

      // 2. Generate summary
      const result = await AIService.generateSummary({ transcript });

      // 3. Save summary back to Video doc
      await Video.findByIdAndUpdate(videoId, {
        "aiSummary.status": "completed",
        "aiSummary.summary": result.summary,
        "aiSummary.keyTakeaways": result.keyTakeaways,
        "aiSummary.technologies": result.technologies,
      });

      console.log(`[AI] Summary completed for ${videoId}`);
    } catch (err) {
      console.error(`[AI] Summary failed for ${videoId}:`, err);
      // Save error details to database
      await Video.findByIdAndUpdate(videoId, {
        "aiSummary.status": "failed",
        "aiSummary.error": err instanceof Error ? err.message : String(err),
      });
      throw err; // Allow BullMQ to handle retry/backoff
    }
  },
  {
    connection: redisConnection,
    concurrency: 2,
  }
);

registerGracefulShutdown({ worker: aiWorker });

console.log("AI Worker started");

export default aiWorker;
