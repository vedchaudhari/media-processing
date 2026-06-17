import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Worker, type Job } from "bullmq";
import { redisConnection } from "../config/redis.js";
import { TRANSCODER_QUEUE } from "../queue/transcoder.queue.js";
import { connectDB } from "../config/db.js";
import {
  downloadObject,
  uploadObject,
  removeObjects,
} from "../services/storage.service.js";
import { transcodeVariant } from "../services/transcoder.service.js";
import { VIDEO_BUCKET } from "../config/minio.js";
import Video, { type IGeneratedFile } from "../models/video.model.js";

await connectDB();

const transcoderWorker = new Worker(
  TRANSCODER_QUEUE,
  async (job: Job) => {
    const { videoId } = job.data;
    const workDir = path.join(os.tmpdir(), `${videoId}-transcode`);
    const inputPath = path.join(workDir, "original.mp4");

    console.log(`Transcoding... videoId: ${videoId}`);

    // track objects uploaded so far so we can clean up on failure
    const uploadedKeys: string[] = [];

    try {
      const video = await Video.findByIdAndUpdate(
        videoId,
        { status: "transcoding" },
        { returnDocument: "after" }
      );

      if (!video?.objectKey || !video.variants?.length) {
        throw new Error(`Video ${videoId} is not ready for transcoding`);
      }

      // variants live next to the original: videos/<uuid>/<height>p.mp4
      const prefix = path.posix.dirname(video.objectKey);

      await fs.promises.mkdir(workDir, { recursive: true });
      await downloadObject(VIDEO_BUCKET, video.objectKey, inputPath);

      const generatedFiles: IGeneratedFile[] = [];
      const total = video.variants.length;

      // v1: transcode variants sequentially (no parallelism)
      for (let i = 0; i < total; i++) {
        const variant = video.variants[i]!;
        const { height, bitrate } = variant;

        if (!height || !bitrate) {
          throw new Error(`Invalid variant at index ${i} for video ${videoId}`);
        }

        const outputPath = path.join(workDir, `${height}p.mp4`);
        const objectKey = `${prefix}/${height}p.mp4`;

        await transcodeVariant({ inputPath, outputPath, height, bitrate });
        await uploadObject(VIDEO_BUCKET, objectKey, outputPath);
        uploadedKeys.push(objectKey);

        generatedFiles.push({ height, objectKey });
        await job.updateProgress(Math.round(((i + 1) / total) * 100));
      }

      const completed = await Video.findByIdAndUpdate(
        videoId,
        { generatedFiles, status: "completed" },
        { returnDocument: "after" }
      );

      console.log("Transcoded video:", JSON.stringify(completed, null, 2));
    } catch (err) {
      // all-or-nothing: clean up any partial uploads and fail the whole job
      await removeObjects(VIDEO_BUCKET, uploadedKeys);
      await Video.findByIdAndUpdate(videoId, { status: "failed" });
      throw err; // let BullMQ record the job as failed
    } finally {
      await fs.promises.rm(workDir, { recursive: true, force: true });
    }
  },
  { connection: redisConnection }
);

// log progress ticks (the values reported via job.updateProgress)
transcoderWorker.on("progress", (job, progress) => {
  console.log(`Progress... videoId: ${job.data.videoId} -> ${progress}%`);
});

export default transcoderWorker;
