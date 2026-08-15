import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Worker, type Job } from "bullmq";
import { redisConnection } from "../config/redis.js";
import { TRANSCRIPT_QUEUE } from "../queue/transcript.queue.js";
import { connectDB } from "../config/db.js";
import { registerGracefulShutdown } from "../config/shutdown.js";
import { downloadObject, uploadObject } from "../services/storage.service.js";
import { extractAudio, hasAudioStream, runTranscription } from "../services/transcript.service.js";
import { VIDEO_BUCKET } from "../config/minio.js";
import Video from "../models/video.model.js";
import { aiQueue } from "../queue/ai.queue.js";
import { embeddingQueue } from "../queue/embedding.queue.js";
import type { TranscribeVideoJob } from "../queue/types.js";

await connectDB();

const transcriptWorker = new Worker(
  TRANSCRIPT_QUEUE,
  async (job: Job<TranscribeVideoJob>) => {
    const { videoId } = job.data;
    const workDir = path.join(os.tmpdir(), `${videoId}-transcript`);
    const localInput = path.join(workDir, "original.mp4");
    const localAudio = path.join(workDir, "audio.wav");
    const localJson = path.join(workDir, "transcript.json");

    console.log(`Transcribing... videoId: ${videoId}`);

    try {

      await Video.findByIdAndUpdate(videoId, {
        "transcript.status": "processing",
        $unset: { "transcript.error": "" },
      });

      const video = await Video.findById(videoId);
      if (!video?.objectKey) {
        throw new Error(`Video ${videoId} has no objectKey`);
      }

      await fs.promises.mkdir(workDir, { recursive: true });

      await downloadObject(VIDEO_BUCKET, video.objectKey, localInput);

      if (!(await hasAudioStream(localInput))) {
        await Video.findByIdAndUpdate(videoId, {
          transcript: { status: "completed", text: "", segments: [] },
          "aiSummary.status": "skipped",
          "vectorIndex.status": "skipped",
        });
        console.log(`Video ${videoId} has no audio stream; marking transcript empty & skipping AI jobs`);
        return;
      }

      await extractAudio(localInput, localAudio);

      await runTranscription(localAudio, localJson, "tiny");

      const transcriptData = JSON.parse(await fs.promises.readFile(localJson, "utf-8"));

      const prefix = path.posix.dirname(video.objectKey);
      const transcriptKey = `${prefix}/transcript.json`;
      await uploadObject(VIDEO_BUCKET, transcriptKey, localJson);

      await Video.findByIdAndUpdate(videoId, {
        transcript: {
          status: "completed",
          text: transcriptData.text,
          segments: transcriptData.segments,
          objectKey: transcriptKey,
        },
      });

      if (typeof transcriptData.text === "string" && transcriptData.text.trim()) {
        await Promise.all([
          aiQueue.add("generate-summary", { videoId }),
          embeddingQueue.add("generate-embeddings", { videoId }),
        ]);
      } else {
        await Video.findByIdAndUpdate(videoId, {
          "aiSummary.status": "skipped",
          "vectorIndex.status": "skipped",
        });
        console.log(`No transcript text for ${videoId}; skipping AI summary & embeddings`);
      }

      console.log(`Transcription completed: ${transcriptKey}`);
    } catch (err) {
      console.error(`Transcription failed for ${videoId}:`, err);

      const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (isFinalAttempt) {
        await Video.findByIdAndUpdate(videoId, {
          "transcript.status": "failed",
          "transcript.error": err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    } finally {
      await fs.promises.rm(workDir, { recursive: true, force: true });
    }
  },
  { connection: redisConnection }
);

registerGracefulShutdown({ worker: transcriptWorker, queues: [aiQueue, embeddingQueue] });

export default transcriptWorker;
