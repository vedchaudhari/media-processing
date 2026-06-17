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
  uploadDirectory,
  removeObjects,
} from "../services/storage.service.js";
import {
  transcodeVariant,
  buildMasterPlaylist,
  type MasterPlaylistEntry,
} from "../services/transcoder.service.js";
import { VIDEO_BUCKET } from "../config/minio.js";
import Video, { type IStreamingVariant } from "../models/video.model.js";

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

      // transcode every variant in parallel; each one is an independent
      // FFmpeg process writing to its own folder, so they don't collide.
      // Promise.allSettled (not Promise.all) lets every task finish even if
      // one fails, so `uploadedKeys` is complete before any rollback runs.
      const results = await Promise.allSettled(
        video.variants.map(async (variant, i) => {
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

          await job.updateProgress(Math.round((++done / total) * 100));

          return { height, width: widthFor(height), bitrate };
        })
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
        },
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
