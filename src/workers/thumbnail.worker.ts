import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Worker, type Job } from "bullmq";
import { redisConnection } from "../config/redis.js";
import { THUMBNAIL_QUEUE } from "../queue/thumbnail.queue.js";
import { connectDB } from "../config/db.js";
import { registerGracefulShutdown } from "../config/shutdown.js";
import { downloadObject, uploadObject } from "../services/storage.service.js";
import { extractThumbnail, pickTimestamp } from "../services/thumbnail.service.js";
import { VIDEO_BUCKET } from "../config/minio.js";
import Video from "../models/video.model.js";

await connectDB();

const thumbnailWorker = new Worker(
  THUMBNAIL_QUEUE,
  async (job: Job) => {
    const { videoId } = job.data;
    const workDir = path.join(os.tmpdir(), `${videoId}-thumbnail`);
    const localInput = path.join(workDir, "original.mp4");
    const localOutput = path.join(workDir, "thumbnail.jpg");

    console.log(`Generating thumbnail... videoId: ${videoId}`);

    try {
      const video = await Video.findById(videoId);
      if (!video?.objectKey) {
        throw new Error(`Video ${videoId} has no objectKey`);
      }

      await fs.promises.mkdir(workDir, { recursive: true });
      await downloadObject(VIDEO_BUCKET, video.objectKey, localInput);

      const timestamp = pickTimestamp(video.metadata?.duration);
      await extractThumbnail(localInput, localOutput, timestamp);

      // Upload thumbnail next to original: videos/<uuid>/thumbnail.jpg
      const prefix = path.posix.dirname(video.objectKey);
      const thumbnailKey = `${prefix}/thumbnail.jpg`;

      await uploadObject(VIDEO_BUCKET, thumbnailKey, localOutput);

      await Video.findByIdAndUpdate(videoId, {
        thumbnail: thumbnailKey,
      });

      console.log(`Thumbnail generated: ${thumbnailKey}`);
    } catch (err) {
      // Non-blocking: log the error but do NOT update video status to "failed".
      // The main pipeline (planner → transcoder) continues regardless.
      console.error(`Thumbnail generation failed for ${videoId}:`, err);
      throw err; // let BullMQ retry (3 attempts from defaultJobOptions)
    } finally {
      await fs.promises.rm(workDir, { recursive: true, force: true });
    }
  },
  { connection: redisConnection }
);

// drain the in-flight job and release connections on SIGINT/SIGTERM
registerGracefulShutdown({ worker: thumbnailWorker });

export default thumbnailWorker;
