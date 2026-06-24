# Thumbnail Generation — Backend Implementation Plan

## Architecture

```
Upload → Inspect → ┬── Planner → Transcoder
                    └── Thumbnail (parallel, non-blocking)
```

After inspection, the inspection worker enqueues **two** jobs in parallel:
1. `plannerQueue.add("plan-video", { videoId })`
2. `thumbnailQueue.add("generate-thumbnail", { videoId })`

Thumbnail generation is **fire-and-forget** — if it fails, the main pipeline (planner → transcoder) is unaffected. The video status machine stays unchanged.

## Why After Inspection?

The thumbnail worker needs data that only exists after ffprobe runs:
- `videoId` — to update the doc
- `metadata.duration` — to pick a meaningful frame (not a black intro)
- `objectKey` — to download the original video

## Files to Create

### 1. `src/queue/thumbnail.queue.ts`

Same pattern as existing queues.

```ts
import { Queue } from "bullmq";
import { redisConnection } from "../config/redis.js";
import { defaultJobOptions } from "../config/queueconfig.js";

export const THUMBNAIL_QUEUE = "thumbnail";

export const thumbnailQueue = new Queue(THUMBNAIL_QUEUE, {
  connection: redisConnection,
  defaultJobOptions,
});
```

---

### 2. `src/services/thumbnail.service.ts`

Extracts a single JPEG frame from a video using ffmpeg.

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Extracts a single frame from `inputPath` at `timestampSec` and writes
 * it to `outputPath` as a JPEG.
 *
 * Uses -vframes 1 (single frame) + -q:v 2 (high quality JPEG).
 * The scale filter caps the width at 640px, keeping aspect ratio.
 */
export const extractThumbnail = async (
  inputPath: string,
  outputPath: string,
  timestampSec: number
): Promise<void> => {
  await execFileAsync("ffmpeg", [
    "-ss", String(timestampSec),     // seek first (fast)
    "-i", inputPath,
    "-vframes", "1",                 // single frame
    "-vf", "scale=640:-2",           // 640px wide, keep aspect, even height
    "-q:v", "2",                     // JPEG quality (2 = high)
    "-y",                            // overwrite
    outputPath,
  ]);
};

/**
 * Picks a timestamp for the thumbnail.
 * - Uses 25% of duration (avoids black intros/outros).
 * - Falls back to 0 if duration is missing.
 * - Clamps to at least 1s (if video is long enough) to skip fade-ins.
 */
export const pickTimestamp = (duration?: number): number => {
  if (!duration || duration <= 0) return 0;
  const target = duration * 0.25;
  return Math.min(target, duration - 0.1); // don't overshoot
};
```

---

### 3. `src/workers/thumbnail.worker.ts`

Follows the exact pattern of inspection/planner/transcoder workers.

```ts
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
      // The main pipeline continues regardless.
      console.error(`Thumbnail generation failed for ${videoId}:`, err);
      throw err; // let BullMQ retry (3 attempts from defaultJobOptions)
    } finally {
      await fs.promises.rm(workDir, { recursive: true, force: true });
    }
  },
  { connection: redisConnection }
);

registerGracefulShutdown({ worker: thumbnailWorker });

export default thumbnailWorker;
```

**Key difference from other workers:** on failure, this does NOT set `video.status = "failed"` or `failedStage`. It only logs and lets BullMQ retry. The video pipeline is unaffected.

---

## Files to Modify

### 4. `src/models/video.model.ts`

Add `thumbnail` field to store the MinIO object key.

```diff
 export interface IVideo extends Document {
   title?: string;
   objectKey?: string;
   status: VideoStatus;
   progress?: number;
+  thumbnail?: string;        // objectKey of the generated thumbnail JPEG
   metadata?: IVideoMetadata;
   ...
 }

 const videoSchema = new Schema<IVideo>(
   {
     title: { type: String },
     objectKey: { type: String },
     status: { ... },
     progress: { type: Number, default: 0 },
+    thumbnail: { type: String },
     metadata: { ... },
     ...
   }
 );
```

---

### 5. `src/workers/inspection.worker.ts`

Import the thumbnail queue and enqueue alongside the planner.

```diff
 import { plannerQueue } from "../queue/planner.queue.js";
+import { thumbnailQueue } from "../queue/thumbnail.queue.js";

 // after saving metadata and setting status to "inspected":

-await plannerQueue.add("plan-video", { videoId });
+await Promise.all([
+  plannerQueue.add("plan-video", { videoId }),
+  thumbnailQueue.add("generate-thumbnail", { videoId }),
+]);
```

Also update the graceful shutdown registration to include the new queue:

```diff
-registerGracefulShutdown({ worker: inspectionWorker, queues: [plannerQueue] });
+registerGracefulShutdown({ worker: inspectionWorker, queues: [plannerQueue, thumbnailQueue] });
```

---

### 6. `src/services/storage.service.ts`

Update the public-read bucket policy to also cover thumbnails.

```diff
 Resource: [
   `arn:aws:s3:::${bucketName}/*/hls/*`,
+  `arn:aws:s3:::${bucketName}/*/thumbnail.jpg`,
 ],
```

Rename the function from `setHlsPublicReadPolicy` → `setPublicReadPolicy` (since it now covers more than HLS). Update all call sites accordingly (startup/index.ts, etc.).

---

### 7. `package.json`

Add the thumbnail worker script and include it in `dev:all`.

```diff
 "scripts": {
   "dev": "tsx watch src/index.ts",
-  "dev:all": "concurrently -n api,inspection,planner,transcoder -c blue,green,yellow,magenta \"npm:dev\" \"npm:worker:inspection\" \"npm:worker:planner\" \"npm:worker:transcoder\"",
+  "dev:all": "concurrently -n api,inspection,planner,transcoder,thumbnail -c blue,green,yellow,magenta,cyan \"npm:dev\" \"npm:worker:inspection\" \"npm:worker:planner\" \"npm:worker:transcoder\" \"npm:worker:thumbnail\"",
   "worker:inspection": "tsx watch src/workers/inspection.worker.ts",
   "worker:planner": "tsx watch src/workers/planner.worker.ts",
   "worker:transcoder": "tsx watch src/workers/transcoder.worker.ts",
+  "worker:thumbnail": "tsx watch src/workers/thumbnail.worker.ts",
 }
```

---

### 8. `src/controllers/video.controller.ts`

Expose the thumbnail URL in the API responses.

**`listVideos`** — add `thumbnail` to the select projection:

```diff
 const videos = await Video.find()
-  .select("title status progress createdAt")
+  .select("title status progress thumbnail createdAt")
   .sort({ createdAt: -1 })
   .lean();
```

And include the full URL in the mapped result:

```diff
 const result = videos.map((v) => ({
   id: v._id,
   title: v.title,
   status: v.status,
   progress: v.progress ?? 0,
+  thumbnailUrl: v.thumbnail
+    ? `${env.minio.publicUrl}/${VIDEO_BUCKET}/${v.thumbnail}`
+    : null,
   createdAt: v.createdAt,
 }));
```

**`getPlay`** — include in the play response too (optional, for the detail page):

```diff
 return res.status(200).json({
   success: true,
   videoId: video._id,
   title: video.title,
   status: video.status,
   playbackUrl,
+  thumbnailUrl: video.thumbnail
+    ? `${env.minio.publicUrl}/${VIDEO_BUCKET}/${video.thumbnail}`
+    : null,
 });
```

---

## Thumbnail Spec

| Property | Value |
|---|---|
| Format | JPEG |
| Max width | 640px (height auto, aspect preserved) |
| Quality | `-q:v 2` (high) |
| Timestamp | 25% of video duration |
| Storage path | `videos/<uuid>/thumbnail.jpg` |
| Access | Public-read via bucket policy |

## Summary of All Changes

| # | File | Action |
|---|---|---|
| 1 | `src/queue/thumbnail.queue.ts` | **CREATE** — new BullMQ queue |
| 2 | `src/services/thumbnail.service.ts` | **CREATE** — ffmpeg frame extraction + timestamp picker |
| 3 | `src/workers/thumbnail.worker.ts` | **CREATE** — worker (non-blocking on failure) |
| 4 | `src/models/video.model.ts` | **MODIFY** — add `thumbnail` field |
| 5 | `src/workers/inspection.worker.ts` | **MODIFY** — enqueue thumbnail job alongside planner |
| 6 | `src/services/storage.service.ts` | **MODIFY** — add `*/thumbnail.jpg` to public-read policy |
| 7 | `package.json` | **MODIFY** — add `worker:thumbnail` script + update `dev:all` |
| 8 | `src/controllers/video.controller.ts` | **MODIFY** — expose `thumbnailUrl` in list + play responses |
