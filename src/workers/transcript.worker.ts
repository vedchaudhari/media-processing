import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Worker, type Job } from "bullmq";
import { redisConnection } from "../config/redis.js";
import { TRANSCRIPT_QUEUE } from "../queue/transcript.queue.js";
import { connectDB } from "../config/db.js";
import { registerGracefulShutdown } from "../config/shutdown.js";
import { downloadObject, uploadObject } from "../services/storage.service.js";
import { extractAudio, runTranscription } from "../services/transcript.service.js";
import { VIDEO_BUCKET } from "../config/minio.js";
import Video from "../models/video.model.js";
import { aiQueue } from "../queue/ai.queue.js";


await connectDB();

const transcriptWorker = new Worker(
  TRANSCRIPT_QUEUE,
  async (job: Job) => {
    const { videoId } = job.data;
    const workDir = path.join(os.tmpdir(), `${videoId}-transcript`);
    const localInput = path.join(workDir, "original.mp4");
    const localAudio = path.join(workDir, "audio.wav");
    const localJson = path.join(workDir, "transcript.json");

    console.log(`Transcribing... videoId: ${videoId}`);

    try {
      // 1. Update status to processing on the nested transcript object
      await Video.findByIdAndUpdate(videoId, {
        "transcript.status": "processing",
        $unset: { "transcript.error": "" },
      });

      const video = await Video.findById(videoId);
      if (!video?.objectKey) {
        throw new Error(`Video ${videoId} has no objectKey`);
      }

      await fs.promises.mkdir(workDir, { recursive: true });

      // 2. Download original video
      await downloadObject(VIDEO_BUCKET, video.objectKey, localInput);

      // 3. Extract audio
      await extractAudio(localInput, localAudio);

      // 4. Run Python Whisper transcription
      await runTranscription(localAudio, localJson, "tiny");

      // 5. Read output JSON file
      const transcriptData = JSON.parse(await fs.promises.readFile(localJson, "utf-8"));

      // 6. Upload transcript JSON to MinIO next to the original video
      const prefix = path.posix.dirname(video.objectKey);
      const transcriptKey = `${prefix}/transcript.json`;
      await uploadObject(VIDEO_BUCKET, transcriptKey, localJson);

      // 7. Update Video doc in DB
      await Video.findByIdAndUpdate(videoId, {
        transcript: {
          status: "completed",
          text: transcriptData.text,
          segments: transcriptData.segments,
          objectKey: transcriptKey,
        },
      });

      // 8. Queue AI summary job
      await aiQueue.add("generate-summary", { videoId });

      console.log(`Transcription completed: ${transcriptKey}`);
    } catch (err) {
      console.error(`Transcription failed for ${videoId}:`, err);
      // Update database status to failed, saving the error message
      await Video.findByIdAndUpdate(videoId, {
        "transcript.status": "failed",
        "transcript.error": err instanceof Error ? err.message : String(err),
      });
      throw err; // let BullMQ retry (3 attempts by default)
    } finally {
      await fs.promises.rm(workDir, { recursive: true, force: true });
    }
  },
  { connection: redisConnection }
);

registerGracefulShutdown({ worker: transcriptWorker, queues: [aiQueue] });

export default transcriptWorker;
