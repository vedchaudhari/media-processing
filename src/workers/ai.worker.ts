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

      const transcript = video.transcript?.text?.trim();
      if (!transcript) {
        // No speech in the video → nothing to summarize. This is a normal
        // terminal outcome, not a failure, so mark it "skipped" and stop
        // (don't throw — a retry wouldn't produce a transcript either).
        console.log(`[AI] No transcript text for ${videoId}; skipping summary`);
        await Video.findByIdAndUpdate(videoId, {
          "aiSummary.status": "skipped",
          $unset: { "aiSummary.error": "" },
        });
        return;
      }
      const segments = video.transcript?.segments;

      // 2. Generate summary + chapters
      const result = await AIService.generateSummary({ transcript, segments });

      // 3. Save summary back to Video doc
      await Video.findByIdAndUpdate(videoId, {
        "aiSummary.status": "completed",
        "aiSummary.summary": result.summary,
        "aiSummary.keyTakeaways": result.keyTakeaways,
        "aiSummary.technologies": result.technologies,
        "aiSummary.chapters": result.chapters,
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
