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
import Video, { type IStreamingVariant } from "../models/video.model.js";

/**
 * Runs `task` over every item with at most `limit` running concurrently, and
 * ALWAYS settles every item (never short-circuits) so the caller can inspect
 * each outcome and roll back side effects. Results are returned in input order.
 *
 * This replaces a bare `Promise.allSettled(items.map(...))`, which would launch
 * one FFmpeg process per variant simultaneously — fine for CPU bursts, but it
 * exceeds NVENC's concurrent-session limit on consumer NVIDIA GPUs and can
 * saturate CPU/RAM for software encodes.
 */
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
  async (job: Job) => {
    const { videoId } = job.data;
    const workDir = path.join(os.tmpdir(), `${videoId}-transcode`);
    const inputPath = path.join(workDir, "original.mp4");

    console.log(`Transcoding... videoId: ${videoId}`);

    // track objects uploaded so far so we can clean up on failure
    const uploadedKeys: string[] = [];

    try {
      // clear any failure context from a previous attempt (retries reuse the doc)
      const video = await Video.findByIdAndUpdate(
        videoId,
        {
          status: "transcoding",
          progress: 0,
          $unset: { failedStage: "", error: "", failedAt: "" },
        },
        { returnDocument: "after" }
      );

      if (!video?.objectKey || !video.variants?.length) {
        throw new Error(`Video ${videoId} is not ready for transcoding`);
      }

      // HLS output lives next to the original: videos/<uuid>/hls/...
      const prefix = path.posix.dirname(video.objectKey);
      const hlsPrefix = `${prefix}/hls`;

      await fs.promises.mkdir(workDir, { recursive: true });
      await downloadObject(VIDEO_BUCKET, video.objectKey, inputPath);

      // derive each variant's width from the source aspect ratio (fallback 16:9)
      const { width: srcWidth, height: srcHeight } = video.metadata ?? {};
      const widthFor = (h: number): number => {
        const ratio = srcWidth && srcHeight ? srcWidth / srcHeight : 16 / 9;
        const w = Math.round(h * ratio);
        return w % 2 === 0 ? w : w + 1; // x264 requires even dimensions
      };

      const total = video.variants.length;
      let done = 0;

      // Transcode variants with bounded concurrency. Each one is an independent
      // FFmpeg process writing to its own folder, so they don't collide, but we
      // cap how many run at once (NVENC session limits / CPU saturation).
      // settleWithConcurrency never short-circuits, so `uploadedKeys` is
      // complete before any rollback runs.
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

          // produce the HLS playlist + segments, then upload the whole folder
          await transcodeVariant({ inputPath, outputDir: variantDir, height, bitrate });
          const keys = await uploadDirectory(
            VIDEO_BUCKET,
            variantDir,
            `${hlsPrefix}/${height}p`
          );
          uploadedKeys.push(...keys);

          // report progress to BullMQ and persist it on the doc so the API
          // (and frontend) can show a real % bar while transcoding.
          const progress = Math.round((++done / total) * 100);
          await job.updateProgress(progress);
          await Video.findByIdAndUpdate(videoId, { progress });

          return { height, width: widthFor(height), bitrate };
        }
      );

      // if any rendition failed, fail the whole job (uploads already rolled
      // back by the catch via uploadedKeys)
      const rejected = results.find((r) => r.status === "rejected");
      if (rejected) {
        throw (rejected as PromiseRejectedResult).reason;
      }

      // preserve ladder order (allSettled keeps input order)
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

      // build and upload the master playlist that ties the renditions together
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
          progress: 100,
        },
        { returnDocument: "after" }
      );

      console.log("Transcoded video:", JSON.stringify(completed, null, 2));
    } catch (err) {
      // all-or-nothing: clean up any partial uploads and fail the whole job.
      // Cleanup is best-effort — a failure here must NOT prevent marking the
      // video failed or mask the original error that caused the job to fail.
      try {
        await removeObjects(VIDEO_BUCKET, uploadedKeys);
      } catch (cleanupErr) {
        console.error(
          `Rollback cleanup failed for ${videoId} (orphaned objects may remain):`,
          cleanupErr
        );
      }
      // Only mark the video "failed" once retries are exhausted. On earlier
      // attempts BullMQ will retry after a backoff, so leaving the status as-is
      // keeps the record in an in-progress state instead of briefly advertising
      // a terminal failure the poller would latch onto.
      const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (isFinalAttempt) {
        await Video.findByIdAndUpdate(videoId, {
          status: "failed",
          failedStage: "transcoding",
          error: err instanceof Error ? err.message : String(err),
          failedAt: new Date(),
        });
      }
      throw err; // let BullMQ record the job as failed (and retry if attempts remain)
    } finally {
      await fs.promises.rm(workDir, { recursive: true, force: true });
    }
  },
  { connection: redisConnection, concurrency: env.transcode.jobConcurrency }
);

// log progress ticks (the values reported via job.updateProgress)
transcoderWorker.on("progress", (job, progress) => {
  console.log(`Progress... videoId: ${job.data.videoId} -> ${progress}%`);
});

// drain the in-flight (long-running) transcode and release connections on
// SIGINT/SIGTERM. close() waits for the active job, capped by the force timer.
registerGracefulShutdown({ worker: transcoderWorker });

export default transcoderWorker;
