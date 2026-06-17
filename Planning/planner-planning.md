# Plan: Planner Worker

## Context
The **planner is the contract between the inspector and the (future) transcoder.** The
inspector probes the uploaded file and writes `metadata` (including `height`). The planner reads
that metadata and decides **which renditions (variants) should be produced** — writing a
`variants` array and moving the video to `status: "planned"`. It does NOT transcode anything yet;
it only produces the plan the transcoder will later execute.

Flow: `uploaded -> inspecting -> inspected -> planning -> planned` (`failed` on error).

## The rules

### Bitrate presets (fixed)
```ts
const PRESETS = {
  2160: 12_000_000,
  1080: 5_000_000,
  720:  2_800_000,
  480:  1_200_000,
};
```

### Rendition ladder
Generate every preset rung **at or below the original height** (never upscale — "we strictly
don't generate above original's p"):

| Original height | Variants produced |
|---|---|
| 2160p (4K) | 2160, 1080, 720, 480 |
| 1080p (Full HD) | 1080, 720, 480 |
| 720p (HD) | 720, 480 |
| 480p (SD) | 480 |
| **below 480** (e.g. 360) | **source only** — a single variant at the original height |

This generalizes cleanly to non-standard sources (e.g. 1440 -> 1080, 720, 480; 900 -> 720, 480),
since the rule is simply "include each preset `<= original.height`".

### Below-480 source-only case
No preset exists for sub-480 heights, so the single source variant uses the original's own
bitrate from `metadata.bitrate` (fallback: lowest preset `480 -> 1_200_000` if `bitrate` is
missing). Its `height` is the original height (e.g. 360).

## Output shape
The planner writes variants as `{ height, bitrate }` (matching the user's example — `width`/`codec`
in the schema are left unset for now):
```json
{
  "_id": "...",
  "status": "planned",
  "variants": [
    { "height": 1080, "bitrate": 5000000 },
    { "height": 720,  "bitrate": 2800000 },
    { "height": 480,  "bitrate": 1200000 }
  ]
}
```

## Implementation

### 1. Pure planning logic — `src/services/planner.service.ts`
Mirror the `inspectVideo` pattern (pure, testable, no I/O). Takes metadata, returns variants:
```ts
import type { IVideoMetadata, IVideoVariant } from "../models/video.model.js";

const PRESETS: Record<number, number> = {
  2160: 12_000_000,
  1080: 5_000_000,
  720:  2_800_000,
  480:  1_200_000,
};

export const planVariants = (metadata: IVideoMetadata): IVideoVariant[] => {
  const height = metadata.height;
  if (!height) throw new Error("Cannot plan: metadata.height is missing");

  // standard rungs at or below the original height
  const rungs = Object.keys(PRESETS)
    .map(Number)
    .filter((h) => h <= height)
    .sort((a, b) => b - a); // highest first

  if (rungs.length > 0) {
    return rungs.map((h) => ({ height: h, bitrate: PRESETS[h]! }));
  }

  // below 480: source-only variant at the original height
  return [{ height, bitrate: metadata.bitrate ?? PRESETS[480]! }];
};
```

### 2. Planner worker — `src/workers/planner.worker.ts`
Mirror `inspection.worker.ts` (connect DB at startup, use shared `redisConnection`,
`PLANNER_QUEUE`, status transitions, error handling). No temp files / downloads needed — the
planner works purely off the DB metadata.
```ts
import { Worker, type Job } from "bullmq";
import { redisConnection } from "../config/redis.js";
import { PLANNER_QUEUE } from "../queue/planner.queue.js";
import { connectDB } from "../config/db.js";
import { planVariants } from "../services/planner.service.js";
import Video from "../models/video.model.js";

await connectDB();

const plannerWorker = new Worker(
  PLANNER_QUEUE,
  async (job: Job) => {
    const { videoId } = job.data;
    console.log(`Planning... videoId: ${videoId}`);

    try {
      const video = await Video.findByIdAndUpdate(
        videoId,
        { status: "planning" },
        { returnDocument: "after" }
      );
      if (!video) throw new Error(`Video not found: ${videoId}`);
      if (!video.metadata?.height) {
        throw new Error(`Video ${videoId} has no metadata yet — inspection must run first`);
      }

      const variants = planVariants(video.metadata);

      const planned = await Video.findByIdAndUpdate(
        videoId,
        { variants, status: "planned" },
        { returnDocument: "after" }
      );
      console.log("Planned video:", JSON.stringify(planned, null, 2));
    } catch (err) {
      await Video.findByIdAndUpdate(videoId, { status: "failed" });
      throw err;
    }
  },
  { connection: redisConnection }
);

export default plannerWorker;
```

## ⚠️ Critical ordering issue (must fix)
Right now `completeUpload` enqueues **both** `inspect-video` and `plan-video` at the same time,
so they run in parallel. But the planner needs `metadata` that only exists **after** inspection
finishes — so a `plan-video` job will usually find no metadata and fail.

**Recommended fix:** move the `plannerQueue.add("plan-video", { videoId })` call **out of
`completeUpload`** and **into the inspection worker**, right after it sets `status: "inspected"`.
That guarantees planning runs only once metadata is ready.
- Remove the `plannerQueue.add(...)` block from `src/controllers/video.controller.ts`.
- Add it at the end of the success path in `src/workers/inspection.worker.ts`.

(The worker code above defensively throws if metadata is missing, so even without the reorder it
fails loudly rather than silently producing a bad plan — but the reorder is the correct design.)

## Files
- **Add** `src/services/planner.service.ts` — `planVariants(metadata)` pure function.
- **Add** `src/workers/planner.worker.ts` — consumes `PLANNER_QUEUE`.
- **Modify** `src/workers/inspection.worker.ts` — enqueue `plan-video` after `inspected`.
- **Modify** `src/controllers/video.controller.ts` — remove the early `plannerQueue.add`.
- (Existing) `src/queue/planner.queue.ts`, `src/models/video.model.ts` (`IVideoVariant`,
  `planning`/`planned` statuses) — already in place.

## Success criteria
A processed video's MongoDB document eventually contains:
```json
{ "status": "planned", "metadata": { ... }, "variants": [ ... ] }
```

## Out of scope
- No FFmpeg transcoding. The planner only writes the plan; executing it is the transcoder's job.

## Verification
1. Run MinIO (`docker compose up -d`), API (`npm run dev`), inspection worker, and the new
   planner worker (`npx tsx watch src/workers/planner.worker.ts`).
2. Push a video through `initiate-upload` -> upload -> `complete-upload`.
3. Watch: inspection worker logs `inspected`, then planner worker logs `Planned video: {...}`.
4. Confirm the DB record has `status: "planned"` plus both `metadata` and a correct `variants`
   ladder (e.g. a 1080p source -> 1080/720/480; a 360p source -> single 360 variant).
5. Edge cases to spot-check: a 4K source (4 variants), a 720p source (720/480), a sub-480
   source (source-only).
