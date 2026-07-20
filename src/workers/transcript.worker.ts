/**
 * Transcript worker — non-blocking side branch (speech-to-text).
 *
 * Consumes "transcribe-video" jobs: downloads the original, extracts audio,
 * runs the Python Whisper script, uploads transcript.json, and stores the
 * segments/text. If the video has speech it enqueues the AI-summary and
 * embedding jobs; a silent video is marked "skipped" for both.
 *
 * Marks the transcript "failed" only once retries are exhausted, so the
 * frontend keeps polling through transient failures. Runs as its own process.
 */
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

      // 3. Bail early if the source has no audio track at all. Without this,
      // ffmpeg fails with a cryptic "Output file does not contain any stream"
      // error and the transcript latches to "failed". An audio-less video is
      // functionally the same as a silent one, so mark the transcript completed
      // (empty) and skip the downstream AI summary & embedding jobs.
      if (!(await hasAudioStream(localInput))) {
        await Video.findByIdAndUpdate(videoId, {
          transcript: { status: "completed", text: "", segments: [] },
          "aiSummary.status": "skipped",
          "vectorIndex.status": "skipped",
        });
        console.log(`Video ${videoId} has no audio stream; marking transcript empty & skipping AI jobs`);
        return;
      }

      // 4. Extract audio
      await extractAudio(localInput, localAudio);

      // 5. Run Python Whisper transcription
      await runTranscription(localAudio, localJson, "tiny");

      // 6. Read output JSON file
      const transcriptData = JSON.parse(await fs.promises.readFile(localJson, "utf-8"));

      // 7. Upload transcript JSON to MinIO next to the original video
      const prefix = path.posix.dirname(video.objectKey);
      const transcriptKey = `${prefix}/transcript.json`;
      await uploadObject(VIDEO_BUCKET, transcriptKey, localJson);

      // 8. Update Video doc in DB
      await Video.findByIdAndUpdate(videoId, {
        transcript: {
          status: "completed",
          text: transcriptData.text,
          segments: transcriptData.segments,
          objectKey: transcriptKey,
        },
      });

      // 9. Queue AI summary job — but only if there's actual speech to
      // summarize. A silent video yields an empty transcript, so mark the
      // summary "skipped" (a terminal, non-error state) instead of enqueuing a
      // job that would have nothing to work with.
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
      // Only mark "failed" once retries are exhausted. On earlier attempts the
      // status stays "processing", so the frontend keeps polling and sees the
      // retry succeed instead of latching onto a transient failure.
      const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (isFinalAttempt) {
        await Video.findByIdAndUpdate(videoId, {
          "transcript.status": "failed",
          "transcript.error": err instanceof Error ? err.message : String(err),
        });
      }
      throw err; // let BullMQ retry (3 attempts by default)
    } finally {
      await fs.promises.rm(workDir, { recursive: true, force: true });
    }
  },
  { connection: redisConnection }
);

registerGracefulShutdown({ worker: transcriptWorker, queues: [aiQueue, embeddingQueue] });

export default transcriptWorker;
