import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Worker, type Job } from "bullmq";
import { redisConnection } from "../config/redis.js";
import { TRANSCODER_QUEUE } from "../queue/transcoder.queue.js";
import { connectDB } from "../config/db.js";
import { registerGracefulShutdown } from "../config/shutdown.js";
import {
  downloadObject,
  uploadObject,
  uploadDirectory,
  removeObjects,
} from "../services/storage.service.js";
import {
  transcodeVariant,
  buildMasterPlaylist,
  type MasterPlaylistEntry,
} from "../services/transcoder.service.js";
import { VIDEO_BUCKET } from "../config/minio.js";
import { env } from "../config/envconfig.js";
import { computeOverallProgress } from "../services/progress.service.js";
import Video from "../models/video.model.js";
import type { IStreamingVariant } from "../models/video.types.js";
import type { TranscodeVideoJob } from "../queue/types.js";

async function settleWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = { status: "fulfilled", value: await task(items[index]!, index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };

  const lanes = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: lanes }, worker));
  return results;
}

await connectDB();

const transcoderWorker = new Worker(
  TRANSCODER_QUEUE,
  async (job: Job<TranscodeVideoJob>) => {
    const { videoId } = job.data;
    const workDir = path.join(os.tmpdir(), `${videoId}-transcode`);
    const inputPath = path.join(workDir, "original.mp4");

    console.log(`Transcoding... videoId: ${videoId}`);

    const uploadedKeys: string[] = [];

    try {

      const video = await Video.findByIdAndUpdate(
        videoId,
        {
          status: "transcoding",
          progress: computeOverallProgress("transcoding", 0),
          "stageTimestamps.transcodingStartedAt": new Date(),
          $unset: { failedStage: "", error: "", failedAt: "" },
        },
        { returnDocument: "after" }
      );

      if (!video?.objectKey || !video.variants?.length) {
        throw new Error(`Video ${videoId} is not ready for transcoding`);
      }

      const prefix = path.posix.dirname(video.objectKey);
      const hlsPrefix = `${prefix}/hls`;

      await fs.promises.mkdir(workDir, { recursive: true });
      await downloadObject(VIDEO_BUCKET, video.objectKey, inputPath);

      const { width: srcWidth, height: srcHeight } = video.metadata ?? {};
      const widthFor = (h: number): number => {
        const ratio = srcWidth && srcHeight ? srcWidth / srcHeight : 16 / 9;
        const w = Math.round(h * ratio);
        return w % 2 === 0 ? w : w + 1;
      };

      const total = video.variants.length;
      let done = 0;

      const results = await settleWithConcurrency(
        video.variants,
        env.transcode.concurrency,
        async (variant, i) => {
          const { height, bitrate } = variant;

          if (!height || !bitrate) {
            throw new Error(`Invalid variant at index ${i} for video ${videoId}`);
          }

          const variantDir = path.join(workDir, `${height}p`);
          await fs.promises.mkdir(variantDir, { recursive: true });

          await transcodeVariant({ inputPath, outputDir: variantDir, height, bitrate });
          const keys = await uploadDirectory(
            VIDEO_BUCKET,
            variantDir,
            `${hlsPrefix}/${height}p`
          );
          uploadedKeys.push(...keys);

          const transcodeProgress = Math.round((++done / total) * 100);
          await job.updateProgress(transcodeProgress);
          await Video.findByIdAndUpdate(videoId, {
            progress: computeOverallProgress("transcoding", transcodeProgress),
          });

          return { height, width: widthFor(height), bitrate };
        }
      );

      const rejected = results.find((r) => r.status === "rejected");
      if (rejected) {
        throw (rejected as PromiseRejectedResult).reason;
      }

      const masterEntries: MasterPlaylistEntry[] = [];
      const streamingVariants: IStreamingVariant[] = [];
      for (const result of results) {
        if (result.status !== "fulfilled") continue;
        const { height, width, bitrate } = result.value;
        masterEntries.push({ height, width, bitrate });
        streamingVariants.push({
          resolution: `${height}p`,
          playlist: `${hlsPrefix}/${height}p/playlist.m3u8`,
        });
      }

      const masterPath = path.join(workDir, "master.m3u8");
      await fs.promises.writeFile(masterPath, buildMasterPlaylist(masterEntries));
      const masterKey = `${hlsPrefix}/master.m3u8`;
      await uploadObject(VIDEO_BUCKET, masterKey, masterPath);
      uploadedKeys.push(masterKey);

      const completed = await Video.findByIdAndUpdate(
        videoId,
        {
          streaming: { masterPlaylist: masterKey, variants: streamingVariants },
          status: "completed",
          progress: computeOverallProgress("completed"),
          "stageTimestamps.transcodingCompletedAt": new Date(),
        },
        { returnDocument: "after" }
      );

      console.log("Transcoded video:", JSON.stringify(completed, null, 2));
    } catch (err) {

      try {
        await removeObjects(VIDEO_BUCKET, uploadedKeys);
      } catch (cleanupErr) {
        console.error(
          `Rollback cleanup failed for ${videoId} (orphaned objects may remain):`,
          cleanupErr
        );
      }

      const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (isFinalAttempt) {
        await Video.findByIdAndUpdate(videoId, {
          status: "failed",
          failedStage: "transcoding",
          error: err instanceof Error ? err.message : String(err),
          failedAt: new Date(),
        });
      }
      throw err;
    } finally {
      await fs.promises.rm(workDir, { recursive: true, force: true });
    }
  },
  { connection: redisConnection, concurrency: env.transcode.jobConcurrency }
);

transcoderWorker.on("progress", (job, progress) => {
  console.log(`Progress... videoId: ${job.data.videoId} -> ${progress}%`);
});

registerGracefulShutdown({ worker: transcoderWorker });

export default transcoderWorker;
