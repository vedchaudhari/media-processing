# Media Processing Service — Complete Project Overview

> A single-file, top-to-bottom explanation of everything built so far.
> Last updated: 2026-06-17

---

## 1. What this project is

A backend **video processing pipeline**. A client uploads a raw video; the
system inspects it, decides which quality levels to produce, transcodes it into
**HLS adaptive streaming** (multiple resolutions + a master playlist), and stores
everything in object storage so it can be streamed to players.

The whole thing is built around an **asynchronous, queue-driven architecture**:
the HTTP API never does heavy work itself — it just records state and drops jobs
onto queues. Separate worker processes pick those jobs up and do the slow work
(downloading, probing, transcoding) in the background.

**Tech stack**

| Concern              | Choice                                          |
| -------------------- | ----------------------------------------------- |
| Language / runtime   | TypeScript on Node.js (ESM, run via `tsx`)      |
| HTTP framework       | Express 5                                       |
| Database             | MongoDB via Mongoose                            |
| Job queue            | BullMQ (backed by Redis)                        |
| Object storage       | MinIO (S3-compatible)                           |
| Media tooling        | FFmpeg / ffprobe (external binaries)            |

---

## 2. The processing pipeline at a glance

```
Client                API                 Queues / Workers              Storage + DB
  │                     │                         │                          │
  │ 1. POST initiate    │                         │                          │
  ├────────────────────>│  create Video doc       │                          │
  │                     ├─────────────────────────────────────────────────> MongoDB (status: uploading)
  │ <─ presigned PUT ───┤  presigned URL from MinIO                          │
  │                     │                         │                          │
  │ 2. PUT file directly to MinIO ─────────────────────────────────────────> MinIO (original.mp4)
  │                     │                         │                          │
  │ 3. POST complete    │                         │                          │
  ├────────────────────>│  status: uploaded       │                          │
  │                     ├──> inspectionQueue.add   │                          │
  │ <─ 200 ─────────────┤                         │                          │
  │                     │                         │                          │
  │                     │             ┌───────────▼──────────┐               │
  │                     │             │  inspection worker   │ download+ffprobe│
  │                     │             │  status: inspecting  ├──> metadata ──> MongoDB
  │                     │             │  status: inspected   │               │
  │                     │             └───────────┬──────────┘               │
  │                     │              plannerQueue.add                       │
  │                     │             ┌───────────▼──────────┐               │
  │                     │             │   planner worker     │ choose ladder  │
  │                     │             │  status: planning    ├──> variants ──> MongoDB
  │                     │             │  status: planned     │               │
  │                     │             └───────────┬──────────┘               │
  │                     │            transcoderQueue.add                      │
  │                     │             ┌───────────▼──────────┐               │
  │                     │             │  transcoder worker   │ ffmpeg → HLS   │
  │                     │             │  status: transcoding ├──> segments ──> MinIO
  │                     │             │  status: completed   ├──> streaming ─> MongoDB
  │                     │             └──────────────────────┘               │
```

There are **three queues** and **three workers**, chained so each stage hands off
to the next: `inspection → planner → transcoder`. The API only ever touches the
first queue.

---

## 3. Directory layout

```
media-processing/
├── docker-compose.yml         # MinIO container
├── package.json               # scripts + deps
├── tsconfig.json              # strict TS / NodeNext ESM
├── .env                       # secrets + connection strings (gitignored intent)
├── README.md                  # MinIO quickstart docker command
├── Planning/                  # design notes & diagrams (this file lives here)
├── data/                      # MinIO's on-disk storage (the actual stored videos)
└── src/
    ├── index.ts               # API entrypoint (Express app)
    ├── config/
    │   ├── envconfig.ts        # central env loader
    │   ├── db.ts               # MongoDB connection
    │   ├── minio.ts            # MinIO client
    │   └── redis.ts            # Redis connection (shared by BullMQ)
    ├── models/
    │   └── video.model.ts      # Mongoose Video schema + TS interfaces
    ├── routes/
    │   └── video.routes.ts     # /api/videos routes
    ├── controllers/
    │   └── video.controller.ts # initiate-upload / complete-upload handlers
    ├── queue/
    │   ├── inspection.queue.ts  # 3 BullMQ Queue definitions
    │   ├── planner.queue.ts
    │   └── transcoder.queue.ts
    ├── workers/
    │   ├── inspection.worker.ts # 3 BullMQ Worker processes
    │   ├── planner.worker.ts
    │   └── transcoder.worker.ts
    ├── services/
    │   ├── ffprobe.service.ts   # probe metadata
    │   ├── planner.service.ts   # pick rendition ladder
    │   ├── transcoder.service.ts# run ffmpeg, build master playlist
    │   └── storage.service.ts   # MinIO upload/download/remove helpers
    └── startup/
        └── index.ts            # one-time startup tasks (ensure bucket)
```

---

## 4. Configuration layer (`src/config/`)

### `envconfig.ts` — single source of truth for environment
Calls `dotenv.config()` **once**, then exports a frozen `env` object. Every other
module imports `env` from here instead of touching `process.env` directly — this
guarantees dotenv has run before any value is read. Provides sensible localhost
defaults for port, Mongo, Redis, and all five MinIO settings.

### `db.ts` — MongoDB
`connectDB()` connects Mongoose to `env.mongoUri`. On failure it logs and calls
`process.exit(1)` (fail fast — no point running without a database). Called by
both the API (in `index.ts`) and by each worker on startup.

### `minio.ts` — object storage client
Creates a single `Minio.Client` from the env settings (non-SSL, localhost in dev)
and exports it plus `VIDEO_BUCKET` (the bucket name, default `"videos"`).

### `redis.ts` — Redis connection for BullMQ
Creates one shared `ioredis` connection with **`maxRetriesPerRequest: null`** —
this is *required* by BullMQ for queues and workers to share a connection. Logs
connect/error events. All three queues and all three workers reuse this one
connection object.

---

## 5. Data model (`src/models/video.model.ts`)

A single Mongoose model, `Video`, is the backbone of the whole system — it's the
shared state every stage reads and writes. Key pieces:

**`status`** — a finite state machine (typed as `VideoStatus`):
```
uploading → uploaded → inspecting → inspected → planning → planned → transcoding → completed
                                                                                  ↘ failed (from any stage)
```

**Sub-documents**, each filled in by a different stage:
- `metadata` (filled by inspection): `width, height, duration, fps, videoCodec, audioCodec, bitrate`
- `variants` (filled by planner): the rendition ladder — array of `{ height, width, bitrate, codec }`
- `generatedFiles` — `{ height, objectKey }` (defined, not yet populated)
- `streaming` (filled by transcoder): `{ masterPlaylist, variants: [{ resolution, playlist }] }`

`objectKey` stores where the original lives in MinIO. `timestamps: true` adds
`createdAt` / `updatedAt`. Status defaults to `"uploading"` on creation.

---

## 6. The HTTP API

### `index.ts` — entrypoint
Sets up Express with CORS + JSON/urlencoded body parsing, a `/health` check, and
mounts the video routes under `/api/videos`. Startup order matters:
```
connectDB() → runStartupTasks() → app.listen(PORT)
```
So the server only starts accepting requests after the DB is connected and the
storage bucket is guaranteed to exist.

### Routes (`routes/video.routes.ts`)
```
POST /api/videos/initiate-upload         → initiateUpload
POST /api/videos/:videoId/complete-upload → completeUpload
```

### Controller (`controllers/video.controller.ts`)

**`initiateUpload`** implements the **presigned-upload pattern** — the client
uploads straight to MinIO, never streaming bytes through the API:
1. Generate a unique `objectKey`: `videos/<uuid>/original.mp4`.
2. Create the `Video` doc (status defaults to `uploading`).
3. Ask MinIO for a **presigned PUT URL** valid for 1 hour.
4. Return `{ videoId, objectKey, uploadUrl }`.

The client then does a direct `PUT` of the file bytes to `uploadUrl`.

**`completeUpload`** — called by the client after the PUT succeeds:
1. Flip status to `uploaded`.
2. Enqueue an `inspect-video` job on the inspection queue (`{ videoId, objectKey }`).
3. Return 200. From here everything is asynchronous — the workers take over.

---

## 7. Queues (`src/queue/`)

Three near-identical files, each defining one BullMQ `Queue` over the shared Redis
connection, plus exporting the queue name constant:

| File                    | Queue name     | Export                     |
| ----------------------- | -------------- | -------------------------- |
| `inspection.queue.ts`   | `"inspection"` | `inspectionQueue`          |
| `planner.queue.ts`      | `"planner"`    | `plannerQueue`             |
| `transcoder.queue.ts`   | `"transcoder"` | `transcoderQueue`          |

Producers add jobs (the controller → inspection; each worker → the next queue).

---

## 8. Workers (`src/workers/`) — the heart of the pipeline

Each worker is a standalone process (run with `tsx watch`). Each one calls
`connectDB()` at the top (workers are separate processes from the API, so they
need their own DB connection), then constructs a BullMQ `Worker` bound to its
queue and the shared Redis connection.

**Shared pattern in every worker:**
- Set status to the "-ing" form at the start (`inspecting`/`planning`/`transcoding`).
- Do the work.
- Set status to the "-ed" form and **enqueue the next stage**.
- On any error: set status to `failed` and re-throw (so BullMQ records the job
  failure and can retry per its config).
- Clean up temp files in a `finally` block.

### Inspection worker (`inspection.worker.ts`)
1. status → `inspecting`.
2. Create a per-video temp dir under the OS tmpdir; download `original.mp4` from
   MinIO into it (the dir must exist before `fGetObject` writes).
3. `stat` the file to confirm the download, then run **ffprobe** via
   `inspectVideo()` to extract metadata.
4. Save metadata, status → `inspected`.
5. Enqueue `plan-video` on the planner queue.
6. `finally`: recursively delete the temp dir.

### Planner worker (`planner.worker.ts`)
1. status → `planning`.
2. Guard: video must exist and have `metadata.height` (inspection must have run).
3. Call `planVariants(metadata)` to compute the rendition ladder.
4. Save `variants`, status → `planned`.
5. Enqueue `transcode-video` on the transcoder queue.

(No temp files here — it's pure computation, so no cleanup needed.)

### Transcoder worker (`transcoder.worker.ts`) — the most involved
1. status → `transcoding`; guard that `objectKey` and `variants` exist.
2. Compute the HLS output prefix: `videos/<uuid>/hls`.
3. Download the original into a temp work dir.
4. **Transcode every variant in parallel** with `Promise.allSettled` — each
   variant is an independent FFmpeg process writing to its own `<height>p/`
   folder, so they don't collide. `allSettled` (not `all`) ensures every task
   finishes even if one fails, so the `uploadedKeys` list is complete before any
   rollback runs. Each variant:
   - transcodes to HLS (`transcodeVariant`),
   - uploads its whole folder (`uploadDirectory`) and records the keys,
   - reports progress via `job.updateProgress(...)`.
5. If any variant rejected, throw → triggers the rollback path.
6. Build the **master playlist** tying all renditions together, upload it.
7. Save `streaming` (master + per-variant playlists), status → `completed`.
8. **Error path (all-or-nothing):** `removeObjects(uploadedKeys)` rolls back every
   partial upload, status → `failed`, re-throw.
9. `finally`: delete the temp work dir.

A `progress` event listener logs each progress tick (`videoId -> N%`).

---

## 9. Services (`src/services/`) — the reusable logic

Workers stay thin; the real work lives in services so it's testable and isolated.

### `ffprobe.service.ts` — `inspectVideo(filePath)`
Runs `ffprobe -v error -print_format json -show_format -show_streams <file>`
using **`execFile`** (no shell — safe, and we only read metadata). Parses the JSON,
picks the first video and audio streams, and builds an `IVideoMetadata` object
**incrementally** (only assigns fields that are present — never writes `undefined`,
which matters under `exactOptionalPropertyTypes`). Includes a `parseFrameRate`
helper that turns `"30000/1001"` into a rounded fps number.

### `planner.service.ts` — `planVariants(metadata)`
Decides the rendition ladder from fixed bitrate presets:
```
2160p → 12 Mbps,  1080p → 5 Mbps,  720p → 2.8 Mbps,  480p → 1.2 Mbps
```
Rules:
- Generate every preset rung **at or below** the source height (never upscale).
- If the source is below 480p, emit a single "source-only" variant at the original
  height, reusing the source bitrate (falling back to the 480p preset).

### `transcoder.service.ts` — FFmpeg + master playlist
**`transcodeVariant(...)`** runs **one** variant via `spawn` (not `execFile` —
transcoding is long-running and streams output to stderr). FFmpeg args:
- `scale=-2:<height>` — keep aspect ratio, auto-compute an even width.
- H.264 video (`libx264`) at the target bitrate with `maxrate`/`bufsize` capping,
  `preset fast`; AAC audio at 128k.
- HLS output: 6-second VOD segments (`segment_%03d.ts`) + `playlist.m3u8`.
- Resolves on exit code 0, rejects otherwise (with the tail of stderr).

**`buildMasterPlaylist(entries)`** generates the adaptive-streaming master
`.m3u8` — one `#EXT-X-STREAM-INF` (bandwidth + resolution) per rendition, each
pointing at a relative `<height>p/playlist.m3u8` (so the master must sit at the
root of the `hls/` prefix).

### `storage.service.ts` — MinIO helpers
- `createBucket(name)` — make the bucket if it doesn't exist (used at startup).
- `downloadObject(...)` — `fGetObject` to a local path.
- `uploadObject(...)` — `fPutObject`, inferring `Content-Type` from extension
  (`.m3u8` → `application/vnd.apple.mpegurl`, `.ts` → `video/mp2t`) so players
  serve HLS correctly.
- `uploadDirectory(...)` — **recursively** uploads a folder preserving structure
  (playlist + segments), returning every key written so the caller can roll back.
- `removeObjects(...)` — bulk delete (the rollback primitive).

### `startup/index.ts`
`runStartupTasks()` currently just calls `initStorage()`, which ensures the video
bucket exists. Designed as the place to add future one-time init (seeding,
cache warming, schedules).

---

## 10. Infrastructure & tooling

- **`docker-compose.yml`** — runs MinIO (API on `:9000`, web console on `:9001`),
  credentials `minioadmin/minioadmin`, data persisted to `./data`. `README.md`
  has the equivalent raw `docker run` quickstart.
- **`.env`** — currently points Mongo at a **MongoDB Atlas** cluster and Redis at
  a **Redis Cloud** instance, with MinIO local. (Note: real credentials are
  committed here — worth rotating and gitignoring.)
- **`tsconfig.json`** — strict mode, NodeNext ESM, plus the stricter
  `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` (which is why the
  services build metadata objects field-by-field).
- **`data/`** — MinIO's actual storage. You can see one already-processed video
  there: `videos/2f60104c-.../` contains `original.mp4`, an `hls/master.m3u8`,
  and `480p/720p/1080p` folders each with ~20 `.ts` segments — proof the full
  pipeline has run end-to-end.

### npm scripts
```
npm run dev               # API server (tsx watch)
npm run worker:inspection # inspection worker
npm run worker:planner    # planner worker
npm run worker:transcoder # transcoder worker
npm run dev:all           # all four at once (concurrently, color-coded) ← newest addition
npm run build             # tsc → dist/
npm start                 # node dist/index.js
```

`dev:all` was just added via the `concurrently` package so the API plus all three
workers run in a single terminal with labeled, color-coded output.

---

## 11. Key design decisions (the "why")

1. **Presigned uploads** — clients upload directly to MinIO, so the API never
   buffers large files; it stays fast and stateless about bytes.
2. **Queue-per-stage + worker-per-stage** — each stage scales independently and a
   crash in one stage doesn't take down the others. State lives in MongoDB, so
   workers are stateless and restartable.
3. **Status field as a state machine** — every record's progress is observable,
   and `failed` is reachable from any stage for clean error surfacing.
4. **Services vs. workers split** — workers handle orchestration + DB status +
   queueing; services hold pure, reusable logic (probe, plan, transcode, store).
5. **All-or-nothing transcoding** — partial uploads are rolled back on failure, so
   storage never ends up with a half-finished video the DB thinks is complete.
6. **Parallel variant transcoding** with `allSettled` — fast, and the
   complete-before-rollback ordering keeps cleanup correct.
7. **`execFile` for probing, `spawn` for transcoding** — probing is a quick
   shell-free metadata read; transcoding is long-running and needs streamed output.

---

## 12. What's *not* done yet (gaps / next steps)

- **No download/playback/status API** — there's no `GET` endpoint to fetch a
  video's status or its streaming URLs; the data is produced but not yet served.
- **`generatedFiles`** is modeled but never populated.
- **No retry/backoff config** on the queues, no dead-letter handling, no job
  concurrency limits.
- **No thumbnail/poster generation**, no captions/subtitles.
- **No auth** on the API endpoints.
- **No automated tests** (the `test` script is a placeholder).
- **Secrets are committed in `.env`** — should be rotated and gitignored.
- **Codec field on variants** is in the schema but the planner doesn't set it.
```
