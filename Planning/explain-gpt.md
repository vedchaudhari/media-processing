# Backend Deep-Dive — `media-processing`

> A complete, self-contained explanation of the backend. Written so it can be
> handed to another engineer (or an LLM) with zero prior context.

---

## 1. What this backend does

It is a **video transcoding pipeline**. A client uploads a video file; the
backend:

1. Stores the original in object storage (MinIO).
2. Inspects it with `ffprobe` to extract technical metadata (resolution,
   codecs, duration, fps, bitrate).
3. Plans an adaptive-bitrate **rendition ladder** (e.g. 1080p / 720p / 480p)
   based on the source resolution.
4. Transcodes each rendition into **HLS** (HTTP Live Streaming: an `.m3u8`
   playlist plus `.ts` segments) using FFmpeg.
5. Builds a **master HLS playlist** that lets a player (HLS.js) switch between
   renditions adaptively.
6. Exposes a playback URL pointing at the master playlist.

The whole thing is asynchronous and queue-driven so that slow, CPU-heavy work
(FFmpeg) never blocks the HTTP API.

---

## 2. Tech stack

| Concern            | Choice                                                        |
| ------------------ | ------------------------------------------------------------- |
| Language / runtime | TypeScript (strict, ESM `"type":"module"`) on Node.js         |
| Dev runner         | `tsx watch` (no build step needed in dev)                     |
| HTTP framework     | Express 5                                                     |
| Job queue          | BullMQ 5 (Redis-backed)                                        |
| Redis client       | ioredis                                                       |
| Database           | MongoDB via Mongoose 9                                         |
| Object storage     | MinIO (S3-compatible) via the `minio` SDK                     |
| Media tooling      | FFmpeg + ffprobe (external binaries, called via child_process)|
| IDs                | `uuid` v4                                                     |
| Config             | dotenv                                                         |

**External dependencies at runtime:** a MongoDB instance, a Redis instance, a
MinIO instance, and `ffmpeg`/`ffprobe` available on the host `PATH`.

---

## 3. Process model (important)

This backend is **not a single process**. It runs as **four independent
processes** that all talk through Redis (queues) and MongoDB (state):

```
npm run dev                → API server (Express)            src/index.ts
npm run worker:inspection  → Inspection worker               src/workers/inspection.worker.ts
npm run worker:planner     → Planner worker                  src/workers/planner.worker.ts
npm run worker:transcoder  → Transcoder worker               src/workers/transcoder.worker.ts

npm run dev:all            → runs all four at once (via `concurrently`)
```

- The **API server** only handles HTTP requests and enqueues jobs. It does no
  heavy lifting.
- Each **worker** is a long-running process that pulls jobs off one queue,
  does its stage of work, updates MongoDB, and enqueues the next stage.
- Because they're separate processes, each worker calls `connectDB()` on its
  own and opens its own Redis connection.

---

## 4. End-to-end data flow

```
                    ┌─────────────┐
   client ───PUT────▶   MinIO     │   (presigned upload, direct to storage)
      │             └─────────────┘
      │ 1. initiate-upload
      │ 3. complete-upload
      ▼
┌───────────────┐   enqueue    ┌──────────────────┐
│  Express API  │─────────────▶│ inspection queue │
└───────────────┘              └────────┬─────────┘
                                        │
                                        ▼
                            ┌────────────────────────┐
                            │   inspection worker    │  ffprobe → metadata
                            └───────────┬────────────┘
                                        │ enqueue
                                        ▼
                              ┌──────────────────┐
                              │  planner queue   │
                              └────────┬─────────┘
                                       ▼
                            ┌────────────────────────┐
                            │     planner worker     │  build rendition ladder
                            └───────────┬────────────┘
                                        │ enqueue
                                        ▼
                              ┌────────────────────┐
                              │ transcoder queue   │
                              └────────┬───────────┘
                                       ▼
                          ┌──────────────────────────┐
                          │    transcoder worker     │  FFmpeg → HLS → MinIO
                          └────────────┬─────────────┘
                                       ▼
                            status = "completed"
                            playback URL available
```

---

## 5. The Video document & status state machine

Everything about a video lives in one MongoDB document (`Video` model). Its
`status` field is a state machine that drives the whole pipeline:

```
uploading → uploaded → inspecting → inspected → planning → planned → transcoding → completed
     │           │          │            │           │          │            │
     └───────────┴──────────┴────────────┴───────────┴──────────┴────────────┴──▶ failed
```

- `uploading` — doc created, waiting for the client to PUT the file.
- `uploaded` — file confirmed present in MinIO; inspection job enqueued.
- `inspecting` / `inspected` — ffprobe running / done.
- `planning` / `planned` — rendition ladder being computed / done.
- `transcoding` — FFmpeg running.
- `completed` — HLS ready, playable.
- `failed` — any stage errored; `failedStage`, `error`, and `failedAt` record
  the details.

**Document shape (interface `IVideo`):**

```ts
{
  title?: string;
  objectKey?: string;          // e.g. "videos/<uuid>/original.mp4"
  status: VideoStatus;         // the state machine above
  metadata?: {                 // filled by inspection
    width, height, duration, fps, videoCodec, audioCodec, bitrate
  };
  variants?: [                 // filled by planner (the ladder)
    { height, width?, bitrate, codec? }
  ];
  generatedFiles?: [...];      // reserved
  streaming?: {                // filled by transcoder
    masterPlaylist: string;    // object key of master.m3u8
    variants: [{ resolution, playlist }];
  };
  failedStage?: "inspection" | "planning" | "transcoding";
  error?: string;
  failedAt?: Date;
  createdAt, updatedAt;        // mongoose timestamps
}
```

---

## 6. Configuration (`src/config/`)

- **`envconfig.ts`** — the single place that calls `dotenv.config()`. It reads
  `process.env` and exports a typed, frozen `env` object. Every other module
  imports `env` from here instead of touching `process.env`, which guarantees
  dotenv has run before anything reads config. Provides sensible localhost
  defaults for everything.

  Keys: `PORT`, `MONGO_URI`, `REDIS_URL`, and a `minio` block
  (`endPoint`, `port`, `accessKey`, `secretKey`, `bucket`, `publicUrl`).
  `publicUrl` is the base URL clients use to fetch public objects straight from
  MinIO.

- **`db.ts`** — `connectDB()` connects Mongoose. On failure it logs and
  `process.exit(1)` (fail fast).

- **`minio.ts`** — constructs the MinIO `Client` from `env` and exports it plus
  `VIDEO_BUCKET`.

- **`redis.ts`** — constructs the ioredis connection. **Critical detail:**
  `maxRetriesPerRequest: null` is required for BullMQ to share this connection.

- **`queueconfig.ts`** — `defaultJobOptions` shared by every queue:
  ```ts
  { attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: 1000,   // keep last 1000 completed jobs
    removeOnFail: 5000 }      // keep last 5000 failed jobs
  ```
  This gives automatic retry-with-backoff for transient blips (MinIO/Mongo/
  FFmpeg) and caps how much job history Redis retains.

---

## 7. The HTTP API (`src/index.ts`, `routes/`, `controllers/`)

`index.ts` boots Express: enables CORS, JSON + urlencoded body parsing, a
`/health` endpoint, mounts the video routes under `/api/videos`, then
`connectDB() → runStartupTasks() → app.listen()`.

### Routes (`routes/video.routes.ts`)

| Method | Path                                  | Controller       |
| ------ | ------------------------------------- | ---------------- |
| GET    | `/api/videos/get-videos`              | `listVideos`     |
| POST   | `/api/videos/initiate-upload`         | `initiateUpload` |
| POST   | `/api/videos/:videoId/complete-upload`| `completeUpload` |
| GET    | `/api/videos/:videoId/play`           | `getPlay`        |

### Controllers (`controllers/video.controller.ts`)

**`initiateUpload`**
- Generates `objectKey = videos/<uuid>/original.mp4`.
- Creates a `Video` doc (status defaults to `uploading`).
- Returns a **presigned PUT URL** (valid 1 hour) so the client uploads the file
  **directly to MinIO**, not through the API. Response: `{ videoId, objectKey,
  uploadUrl }`.

**`completeUpload`** — the most carefully written endpoint. Steps:
1. Validate `videoId` is a string.
2. `findById`; 404 if missing.
3. **Idempotency guard:** if status isn't `uploading`, return 200 with the
   current status (a repeat call is a harmless no-op, not a duplicate run).
4. **Trust-but-verify:** call `objectExists()` to confirm the file actually
   landed in MinIO; 409 if not.
5. **Atomic claim:** `findOneAndUpdate({ _id, status: "uploading" }, { status:
   "uploaded" })`. This is the *real* race guard — if two completes arrive at
   once, only one matches the filter and gets a non-null doc; the other loses
   the race and just reports current status. Only the winner enqueues.
6. Winner enqueues an `inspect-video` job onto the inspection queue.

**`listVideos`** — returns a lightweight projection (`id, title, status`),
newest first, using `.select().lean()` (no heavy metadata/variants).

**`getPlay`** — validates the id with `mongoose.isValidObjectId`; 404 if
missing; **409 if not `completed`** (so the frontend can show "still processing"
/ "failed" instead of erroring). When ready, returns
`playbackUrl = <publicUrl>/<bucket>/<masterPlaylistKey>`.

---

## 8. Startup tasks (`src/startup/index.ts`)

`runStartupTasks()` runs once before the API serves traffic:
- `createBucket(VIDEO_BUCKET)` — make the bucket if it doesn't exist.
- `setHlsPublicReadPolicy(VIDEO_BUCKET)` — apply a bucket policy granting
  anonymous read **only** to keys matching `*/hls/*`. (See §11 for why.)

---

## 9. The queues (`src/queue/`)

Three thin modules, each exporting a BullMQ `Queue` plus its name constant,
all wired to the shared Redis connection and `defaultJobOptions`:

- `inspection.queue.ts` → queue name `"inspection"`.
- `planner.queue.ts` → queue name `"planner"`.
- `transcoder.queue.ts` → queue name `"transcoder"`.

The API and each worker import these to add or consume jobs.

---

## 10. The workers (`src/workers/`)

All three workers share a common structure:
- Top-level `await connectDB()` (each is its own process).
- A BullMQ `Worker` bound to its queue and the Redis connection.
- A consistent **failure protocol**: on entry they set the in-progress status
  and `$unset` any prior failure context (so retries start clean); on error
  they set `status: "failed"` with `failedStage`/`error`/`failedAt`, then
  **rethrow** so BullMQ marks the job failed and applies retry/backoff.

### 10.1 Inspection worker (`inspection.worker.ts`)
Job data: `{ videoId, objectKey }`.
1. Set status `inspecting`, clear failure fields.
2. `mkdir` a per-video temp dir under `os.tmpdir()`.
3. `downloadObject()` the original from MinIO to the temp dir.
4. `stat` the file (logs the byte size as a sanity check).
5. `inspectVideo()` → metadata.
6. Save `metadata`, set status `inspected`.
7. Enqueue a `plan-video` job (`{ videoId }`).
8. `finally`: recursively remove the temp dir (cleanup always runs).

### 10.2 Planner worker (`planner.worker.ts`)
Job data: `{ videoId }`.
1. Set status `planning`, clear failure fields, fetch the doc.
2. Guard: must exist and have `metadata.height` (inspection must have run).
3. `planVariants(metadata)` → the rendition ladder.
4. Save `variants`, set status `planned`.
5. Enqueue a `transcode-video` job (`{ videoId }`).

### 10.3 Transcoder worker (`transcoder.worker.ts`) — the heavy one
Job data: `{ videoId }`.
1. Set status `transcoding`, clear failure fields, fetch the doc.
2. Guard: must have `objectKey` and at least one variant.
3. Compute the HLS key prefix: alongside the original →
   `videos/<uuid>/hls`.
4. Download the original to a temp dir.
5. Define `widthFor(height)` — derives each rendition's width from the source
   aspect ratio (fallback 16:9), forced to an even number (x264 requirement).
6. **Transcode every variant in parallel** with `Promise.allSettled`. Each
   variant: make its own folder, `transcodeVariant()` (FFmpeg → HLS), then
   `uploadDirectory()` the result to `…/hls/<height>p`. Uploaded object keys
   are tracked in `uploadedKeys`. Progress is reported via
   `job.updateProgress()`.
   - `allSettled` (not `all`) ensures every task finishes even if one fails, so
     `uploadedKeys` is complete before any rollback.
7. If any variant rejected → throw its reason (triggers the catch/rollback).
8. Build the **master playlist** from the fulfilled results (preserves ladder
   order), write it locally, upload it as `…/hls/master.m3u8`.
9. Save `streaming = { masterPlaylist, variants[] }`, set status `completed`.
10. **catch:** `removeObjects(uploadedKeys)` (all-or-nothing rollback of partial
    uploads), set status `failed`, rethrow.
11. **finally:** remove the temp dir.

A `worker.on("progress")` listener logs progress ticks.

---

## 11. Services (`src/services/`) — the reusable logic

### `ffprobe.service.ts` — `inspectVideo(filePath)`
- Runs `ffprobe -v error -print_format json -show_format -show_streams <file>`
  via `execFile` (**no shell**, so no shell-injection surface).
- Parses JSON, finds the video and audio streams, and extracts
  width/height/codecs/fps/duration/bitrate.
- `parseFrameRate("30000/1001")` → rounded fps.
- Builds the metadata object **incrementally**, only assigning fields that are
  actually present — this satisfies the project's `exactOptionalPropertyTypes`
  setting (never assigns `undefined`).

### `planner.service.ts` — `planVariants(metadata)`
- Bitrate presets (bits/sec): `2160→12M`, `1080→5M`, `720→2.8M`, `480→1.2M`.
- **Rules:**
  - Emit every preset rung whose height ≤ the source height (so it **never
    upscales**), highest first.
  - If the source is below 480p, emit a single "source-only" variant at the
    original height, reusing the source bitrate (fallback to the 480 preset).
- Throws if `metadata.height` is missing.

### `transcoder.service.ts`
- **`transcodeVariant({ inputPath, outputDir, height, bitrate, segmentDuration=6 })`**
  - Spawns FFmpeg (via `spawn`, because transcoding is long-running and streams
    progress to stderr). Key args:
    - `-vf scale=-2:<height>` — scale to target height, keep aspect ratio,
      width auto + kept even.
    - `-c:v libx264 -b:v <bitrate> -maxrate <bitrate> -bufsize <2×bitrate>
      -preset fast`.
    - `-c:a aac -b:a 128k`.
    - HLS: `-hls_time <seg> -hls_playlist_type vod -hls_segment_filename
      segment_%03d.ts` → `playlist.m3u8`.
  - Resolves on exit code 0, rejects otherwise (with the last 500 chars of
    stderr). Also rejects if the binary can't be spawned.
- **`buildMasterPlaylist(entries)`** — produces the master `.m3u8` text:
  `#EXTM3U` + `#EXT-X-VERSION:3` + one `#EXT-X-STREAM-INF` (BANDWIDTH +
  RESOLUTION) and a relative `<height>p/playlist.m3u8` line per rendition.
  Because the references are relative, the master **must** sit at the root of
  the `hls/` prefix.

### `storage.service.ts` — MinIO helpers
- `createBucket` — idempotent bucket creation.
- `setHlsPublicReadPolicy` — bucket policy allowing anonymous `s3:GetObject`
  only on `arn:aws:s3:::<bucket>/*/hls/*`. **Why:** HLS playlists reference
  their child playlists and `.ts` segments by *relative* path, so a presigned
  URL's signature is lost on those follow-up requests. Making the whole `hls/`
  tree public-readable lets a browser/HLS.js fetch everything directly with no
  expiry and no per-request signing. Originals stay private.
- `objectExists` — `statObject`, returns `false` on `NotFound`/`NoSuchKey`,
  rethrows anything else (auth/network are real errors).
- `downloadObject` / `uploadObject` — `fGetObject` / `fPutObject`. Uploads
  attach the correct Content-Type for `.m3u8` (`application/vnd.apple.mpegurl`)
  and `.ts` (`video/mp2t`) so players serve them correctly.
- `uploadDirectory` — recursively uploads a local folder under a key prefix
  (preserving structure) and **returns the list of keys written** so the caller
  can roll them back on failure.
- `removeObjects` — bulk delete (used for rollback).

---

## 12. Failure handling & idempotency (design highlights)

- **Atomic claim** in `completeUpload` prevents duplicate pipeline runs under
  concurrent requests.
- **Trust-but-verify** (`objectExists`) before enqueuing — the client can't
  trigger processing for a file that isn't really there.
- **Retry-clean**: each worker `$unset`s prior failure fields on entry, so a
  retried job doesn't carry stale error state.
- **All-or-nothing transcode**: `Promise.allSettled` + tracked `uploadedKeys` +
  `removeObjects` rollback means a failed transcode never leaves partial HLS
  output behind.
- **BullMQ retries**: 3 attempts with exponential backoff absorb transient
  infra hiccups before a video is finally marked `failed`.

---

## 13. Local dev setup

1. Start MinIO (docker-compose only defines MinIO):
   ```
   docker compose up -d        # MinIO on :9000 (API) / :9001 (console)
   ```
   (MongoDB and Redis point at cloud instances via `.env`.)
2. Ensure `ffmpeg` and `ffprobe` are installed and on `PATH`.
3. Create `.env` (see keys in §6).
4. `npm install`
5. `npm run dev:all` — runs the API + all three workers together.

Build for production: `npm run build` (tsc → `dist/`), then `npm start`.

---

## 14. Directory map

```
src/
├── index.ts                      # Express app entry (API process)
├── config/
│   ├── envconfig.ts              # dotenv + typed env object
│   ├── db.ts                     # Mongoose connection
│   ├── minio.ts                  # MinIO client + bucket constant
│   ├── redis.ts                  # ioredis connection (BullMQ-compatible)
│   └── queueconfig.ts            # shared default job options
├── routes/
│   └── video.routes.ts           # /api/videos routes
├── controllers/
│   └── video.controller.ts       # initiate/complete upload, list, play
├── models/
│   └── video.model.ts            # Video schema + TS interfaces + status union
├── queue/
│   ├── inspection.queue.ts
│   ├── planner.queue.ts
│   └── transcoder.queue.ts
├── workers/
│   ├── inspection.worker.ts      # ffprobe → metadata
│   ├── planner.worker.ts         # rendition ladder
│   └── transcoder.worker.ts      # FFmpeg → HLS → MinIO
├── services/
│   ├── ffprobe.service.ts        # inspectVideo()
│   ├── planner.service.ts        # planVariants()
│   ├── transcoder.service.ts     # transcodeVariant(), buildMasterPlaylist()
│   └── storage.service.ts        # MinIO helpers
└── startup/
    └── index.ts                  # ensure bucket + HLS public-read policy
```

---

## 15. Known gaps / things to be aware of

- **No authentication** on any endpoint; **CORS is fully open** (`cors()` with
  no options).
- **No graceful shutdown** — workers/API don't close BullMQ/Redis/Mongo on
  SIGTERM/SIGINT, so in-flight jobs can be dropped on restart.
- **`/health` is shallow** — always returns OK, doesn't probe Mongo/Redis/MinIO.
- **Parallel FFmpeg is uncapped** — a 4K source spawns 4 simultaneous encodes;
  no per-job concurrency limit, so heavy load can saturate CPU/RAM.
- **No requeue path** for `failed` videos once the 3 attempts are exhausted.
- **`completeUpload` doesn't validate ObjectId format** (an invalid id throws a
  CastError → 500, whereas `getPlay` validates and returns 400).
- **`status` has no Mongoose `enum`** — only the TS union enforces valid values;
  a typo in code could persist an invalid status.
- **Master-playlist `RESOLUTION` width** is computed from the source aspect
  ratio and can differ by a pixel from FFmpeg's actual `scale=-2` output
  (cosmetic).
- **Secrets**: `.env` holds live cloud credentials and MinIO uses default
  `minioadmin` creds — fine for local dev, must be secured/rotated for anything
  shared.
