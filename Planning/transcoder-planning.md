# Plan: Transcoder Worker

## Context
Planning is done — each `planned` video has a `variants` ladder (`{ height, bitrate }[]`) in the
DB. The **transcoder** executes that plan: download the original, run FFmpeg once per variant
(sequentially, v1), upload each rendition back to MinIO next to the original, record the produced
files, and mark the video `completed`.

Pipeline so far: `uploading → uploaded → inspecting → inspected → planning → planned`.
This adds: `→ transcoding → completed` (or `failed`).

## ⚠️ Object key / folder correctness (important)
The desired MinIO layout puts renditions beside the original:
```
videos/<id>/
  original.mp4
  1080p.mp4
  720p.mp4
  480p.mp4
```
But the original is stored at the `objectKey` set during upload —
`videos/<uuid>/original.mp4` — where `<uuid>` is a **uuid v4, NOT the Mongo videoId**. So we must
derive the folder from the existing `objectKey`, not from `videoId`:
```ts
import path from "node:path";
const prefix = path.posix.dirname(video.objectKey); // "videos/<uuid>"
const variantKey = `${prefix}/${height}p.mp4`;       // "videos/<uuid>/1080p.mp4"
```
This guarantees variants land in the same folder as `original.mp4`.

## Changes

### 1. Statuses — `src/models/video.model.ts`
Add `"transcoding"` and `"completed"` to `VideoStatus` (`failed` already exists):
```ts
export type VideoStatus =
  | "uploading" | "uploaded"
  | "inspecting" | "inspected"
  | "planning" | "planned"
  | "transcoding" | "completed"
  | "failed";
```

### 2. New field `generatedFiles` — `src/models/video.model.ts`
```ts
export interface IGeneratedFile {
  height?: number;
  objectKey?: string;
}
// on IVideo:
generatedFiles?: IGeneratedFile[];
// schema:
generatedFiles: [{ height: { type: Number }, objectKey: { type: String } }],
```

### 3. Upload helper — `src/services/storage.service.ts`
Add the counterpart to `downloadObject` (streams a local file up via `fPutObject`):
```ts
export const uploadObject = async (
  bucketName: string,
  objectKey: string,
  localPath: string
): Promise<void> => {
  await minioClient.fPutObject(bucketName, objectKey, localPath);
};
```

### 4. Transcoder queue — `src/queue/transcoder.queue.ts` (new)
Mirror the other queues:
```ts
import { Queue } from "bullmq";
import { redisConnection } from "../config/redis.js";
export const TRANSCODER_QUEUE = "transcoder";
export const transcoderQueue = new Queue(TRANSCODER_QUEUE, { connection: redisConnection });
```

### 5. One-variant transcode — `src/services/transcoder.service.ts`
Single responsibility: transcode ONE variant. Use `spawn` (streaming, long-running) — matching
the note in `ffprobe.service.ts` that ffmpeg should use spawn. Resolve on exit 0, reject otherwise.
```ts
import { spawn } from "node:child_process";

interface TranscodeVariantArgs {
  inputPath: string;
  outputPath: string;
  height: number;
  bitrate: number;
}

export const transcodeVariant = ({ inputPath, outputPath, height, bitrate }: TranscodeVariantArgs): Promise<void> => {
  return new Promise((resolve, reject) => {
    const args = [
      "-i", inputPath,
      "-vf", `scale=-2:${height}`,        // keep aspect ratio; width auto, divisible by 2
      "-c:v", "libx264",
      "-b:v", String(bitrate),
      "-maxrate", String(bitrate),
      "-bufsize", String(bitrate * 2),
      "-preset", "fast",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      "-y", outputPath,
    ];
    const ff = spawn("ffmpeg", args);
    let stderr = "";
    ff.stderr.on("data", (d) => { stderr += d.toString(); });
    ff.on("error", reject); // e.g. ffmpeg not on PATH
    ff.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code} for ${height}p: ${stderr.slice(-500)}`));
    });
  });
};
```

### 6. Transcoder worker — `src/workers/transcoder.worker.ts` (new)
Job data: `{ videoId }` (variants + objectKey are fetched from the DB — single source of truth).

Flow (matches the requested pseudocode):
```
receive job -> fetch video -> status=transcoding -> download original
-> for each variant (SEQUENTIAL): transcode -> upload -> record -> updateProgress
-> save generatedFiles + status=completed
-> finally: delete temp dir
```
```ts
await connectDB();

new Worker(TRANSCODER_QUEUE, async (job) => {
  const { videoId } = job.data;
  const workDir = path.join(os.tmpdir(), `${videoId}-transcode`);
  const inputPath = path.join(workDir, "original.mp4");

  try {
    const video = await Video.findByIdAndUpdate(videoId, { status: "transcoding" }, { returnDocument: "after" });
    if (!video?.objectKey || !video.variants?.length) {
      throw new Error(`Video ${videoId} not ready for transcoding`);
    }

    const prefix = path.posix.dirname(video.objectKey); // videos/<uuid>
    await fs.promises.mkdir(workDir, { recursive: true });
    await downloadObject(VIDEO_BUCKET, video.objectKey, inputPath);

    const generatedFiles = [];
    const total = video.variants.length;

    for (let i = 0; i < total; i++) {
      const { height, bitrate } = video.variants[i];
      const outputPath = path.join(workDir, `${height}p.mp4`);
      const objectKey = `${prefix}/${height}p.mp4`;

      await transcodeVariant({ inputPath, outputPath, height, bitrate });
      await uploadObject(VIDEO_BUCKET, objectKey, outputPath);

      generatedFiles.push({ height, objectKey });
      await job.updateProgress(Math.round(((i + 1) / total) * 100)); // 1080->33, 720->66, 480->100
    }

    await Video.findByIdAndUpdate(videoId, { generatedFiles, status: "completed" }, { returnDocument: "after" });
  } catch (err) {
    // all-or-nothing: any variant failure fails the whole job
    await Video.findByIdAndUpdate(videoId, { status: "failed" });
    throw err;
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true });
  }
}, { connection: redisConnection });
```

### 7. Handoff — enqueue transcode after planning
In `src/workers/planner.worker.ts`, after it sets `status: "planned"`, enqueue the transcode job
(same pattern as inspection → planner):
```ts
await transcoderQueue.add("transcode-video", { videoId });
```

## Failure handling (all-or-nothing)
Per the requirement: if 1080p and 720p succeed but **480p fails**, the whole job fails.
- The `for` loop `await`s each variant; the first rejection jumps to `catch`, sets `status: "failed"`,
  and rethrows so BullMQ marks the job failed.
- `generatedFiles` is only written in the success path, so a partial run never records files.
- **Partial uploads:** earlier variants (1080p, 720p) were already uploaded to MinIO before 480p
  failed. To avoid orphans, the `catch` should also delete any already-uploaded variant objects
  for this video (`minioClient.removeObjects`/`removeObject` on the keys produced so far). Track
  uploaded keys in an array and clean them up on failure. (The local temp dir is always removed in
  `finally`.)

## Progress tracking
`await job.updateProgress(pct)` after each variant, computed proportionally
(`Math.round(((i+1)/total)*100)`). For a 3-variant ladder that's 33 / 66 / 100; the requirement's
25/50 example is just illustrative of calling `updateProgress` between steps.

## Prerequisite
`ffmpeg` (and `ffprobe`) must be on the system PATH. `spawn("ffmpeg", ...)` emits an `error` event
(handled → job fails) if it's missing. Verify with `ffmpeg -version`.

## Files
- **Modify** `src/models/video.model.ts` — statuses + `IGeneratedFile` + `generatedFiles`.
- **Modify** `src/services/storage.service.ts` — add `uploadObject`.
- **Modify** `src/workers/planner.worker.ts` — enqueue `transcode-video` after `planned`.
- **Add** `src/queue/transcoder.queue.ts`.
- **Add** `src/services/transcoder.service.ts` — `transcodeVariant`.
- **Add** `src/workers/transcoder.worker.ts`.
- **Modify** `package.json` — add `"worker:transcoder": "tsx watch src/workers/transcoder.worker.ts"`.

## Success criteria
The MongoDB document eventually contains:
```json
{
  "status": "completed",
  "metadata": { ... },
  "variants": [ ... ],
  "generatedFiles": [
    { "height": 1080, "objectKey": "videos/<uuid>/1080p.mp4" },
    { "height": 720,  "objectKey": "videos/<uuid>/720p.mp4" },
    { "height": 480,  "objectKey": "videos/<uuid>/480p.mp4" }
  ]
}
```
And MinIO holds `original.mp4` + one `<height>p.mp4` per variant in the same folder.

## Out of scope (v1)
- No parallel transcoding (sequential `for ... await` loop, as requested).
- No HLS/DASH packaging, no thumbnails, no streaming/playback endpoint.

## Verification
1. Ensure `ffmpeg -version` works; MinIO up; API + all workers running (incl. new transcoder).
2. Push a real video through `initiate-upload → upload → complete-upload`.
3. Watch the chain: inspected → planned → transcoder logs per-variant progress.
4. Confirm DB ends at `status: "completed"` with a correct `generatedFiles` list.
5. Confirm MinIO folder has `original.mp4` plus each `<height>p.mp4`.
6. Failure test: temporarily force a variant to fail (e.g. bogus bitrate) and confirm status
   becomes `failed`, no `generatedFiles` saved, and partial variant objects are cleaned up.
