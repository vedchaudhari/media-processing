# Plan: MinIO Download & Save (Inspection Worker)

## Context
When a user finishes uploading a video, `completeUpload` marks the record `uploaded` and
enqueues an `inspect-video` job on the `inspection` queue (payload: `{ videoId, objectKey }`).
The inspection worker now needs to actually **download the uploaded file from MinIO to local
disk** so it can be probed for metadata (width, height, duration, fps, codecs, bitrate) and the
`Video` record updated.

This plan covers the download-and-save half of that flow: getting the object out of MinIO onto
a temporary local path, reliably, and cleaning up afterward.

## Goal
Inside the inspection worker job handler:
1. Mark the video `inspecting`.
2. Download the object from MinIO to a unique local temp file.
3. (Hand off to metadata extraction — separate step, not in this plan.)
4. Always delete the temp file when done (success or failure).
5. On error, mark the video `failed`.

## Existing pieces to reuse
- `downloadObject(bucketName, objectKey, localPath)` in `src/services/storage.service.ts`
  (wraps MinIO `fGetObject`, streams to disk).
- `VIDEO_BUCKET` and `minioClient` in `src/config/minio.ts`.
- `Video` model + `VideoStatus` (`uploading | uploaded | inspecting | inspected | failed`)
  in `src/models/video.model.ts`.
- Worker scaffold in `src/workers/inspection.worker.ts` (currently just logs the videoId).

## Implementation steps

### 1. Build a safe temp path
Use the OS temp dir (guaranteed to exist) and a unique name to avoid collisions between
concurrent jobs:
```ts
import os from "node:os";
import path from "node:path";

const tmpDir = os.tmpdir();
const localPath = path.join(tmpDir, `${videoId}-original.mp4`);
```
- Do NOT derive the temp filename from untrusted input; use the `videoId`.

### 2. Worker handler flow (`src/workers/inspection.worker.ts`)
```ts
async (job) => {
  const { videoId, objectKey } = job.data;
  const localPath = path.join(os.tmpdir(), `${videoId}-original.mp4`);

  try {
    await Video.findByIdAndUpdate(videoId, { status: "inspecting" });

    // download from MinIO to local disk
    await downloadObject(VIDEO_BUCKET, objectKey, localPath);

    // TODO (next plan): probe metadata with ffprobe, then:
    // await Video.findByIdAndUpdate(videoId, { metadata, status: "inspected" });

  } catch (err) {
    await Video.findByIdAndUpdate(videoId, { status: "failed" });
    throw err; // let BullMQ record the job as failed / retry per queue config
  } finally {
    // always clean up the temp file
    await fs.promises.rm(localPath, { force: true });
  }
}
```

### 3. Worker needs DB + env
- The worker runs as its own process, so it must:
  - `import "dotenv/config";` first (already done).
  - Call `connectDB()` before processing jobs (Mongoose isn't connected in this process yet).
    Add a `connectDB()` call at the top of `inspection.worker.ts`.

### 4. Concurrency / cleanup safety
- `fs.promises.rm(localPath, { force: true })` in `finally` won't throw if the file is missing.
- Each job uses a `videoId`-scoped filename, so parallel jobs don't clobber each other.

## Files to modify / add
- `src/workers/inspection.worker.ts` — add `connectDB()`, the download + temp-file lifecycle.
- (No change needed to `storage.service.ts` — `downloadObject` already exists.)

## Out of scope (follow-up plan)
- FFprobe metadata extraction and writing `metadata` + `status: "inspected"`.
  Will require an ffprobe binary — e.g. `@ffprobe-installer/ffprobe` + `fluent-ffmpeg`
  (or spawning ffprobe directly). None installed yet.

## Verification
1. Ensure managed Redis (`REDIS_URL`) and MinIO are reachable, and the `videos` bucket exists.
2. Start API (`npm run dev`) and worker (`npx tsx src/workers/inspection.worker.ts`).
3. `POST /api/videos/initiate-upload` with a `title`, upload a real file to the returned
   `uploadUrl`, then `POST /api/videos/:videoId/complete-upload`.
4. Confirm the worker logs the job, the video status moves `uploaded -> inspecting`, the temp
   file appears in the OS temp dir during download, and is removed afterward.
5. On a deliberately bad `objectKey`, confirm the status becomes `failed` and no temp file is
   left behind.
