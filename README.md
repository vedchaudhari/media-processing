# Media Processing — Backend

A Node.js/TypeScript backend that turns an uploaded video into an adaptive-bitrate HLS stream, plus a full AI side-pipeline: automatic transcription, an AI-generated summary/chapters, and a RAG-based "Ask AI" chat grounded in the video's own transcript. Built around a Mongo-backed job pipeline coordinated with BullMQ, so the API server and every processing stage run as independent, horizontally-scalable processes.

## Architecture

The app is one Express API process plus **seven independent background worker processes**, all coordinated through MongoDB (state), Redis (BullMQ job queues + pub/sub), and MinIO (object storage). Nothing but the DB record ties the stages together, so any worker can restart, fall behind, or scale out without the others noticing.

```
Client ──(presigned PUT)──> MinIO                    Client <──HLS/HLS.js──── MinIO (public-read hls/*)
   │                                                        ▲
   └─POST /initiate-upload / /complete-upload─> API ────────┘
                                                   │
                                          inspection queue (ffprobe)
                                                   │
                        ┌──────────────┬───────────┴───────────┬──────────────┐
                        ▼              ▼                       ▼              ▼
                    planning      thumbnail                transcript     (fan-out)
                        │                                       │
                        ▼                                       ├──────────────┐
                   transcoding (ffmpeg → HLS variants)           ▼              ▼
                                                              AI summary     embeddings
                                                            (chapters etc)  (Qdrant, for
                                                                             Ask AI / RAG)
```

- **Upload** is direct browser → MinIO via a short-lived presigned URL; the API server never touches raw video bytes.
- **Inspection → Planning → Transcoding** is the critical path that makes a video playable (drives `Video.status`).
- **Transcript → AI summary / Embeddings** is an independent side-branch — each has its own `pending → processing → completed | failed | skipped` status on the same `Video` document, and a failure there never fails the video itself. Failed side-branch stages can be retried individually without re-running the whole pipeline.
- Every DB write to a `Video` document fans out a pub/sub event so the admin dashboard's SSE stream stays live without polling.

## Tech stack

- **Runtime:** Node.js, TypeScript (ESM), Express 5
- **Data:** MongoDB via Mongoose
- **Jobs/queues:** BullMQ on Redis (also used for cross-process pub/sub)
- **Object storage:** MinIO (S3-compatible) — originals, HLS output, thumbnails, transcripts
- **Vector search:** Qdrant — transcript embeddings for the Ask-AI/RAG endpoint
- **AI:** pluggable provider — Google Gemini, OpenAI, or a local Ollama model
- **Speech-to-text:** `faster-whisper` via a Python subprocess (see `python/`)
- **Media:** FFmpeg/ffprobe (external binaries, must be on `PATH`)
- **Auth:** JWT (`jsonwebtoken`) + `bcryptjs`, single hardcoded admin role (no in-app promotion)

## Prerequisites

- Node.js (LTS) and npm
- **FFmpeg + ffprobe** on your `PATH`
- **Python 3** (for the transcription sub-module — see `python/README.md`)
- MongoDB (local or Atlas)
- Redis and MinIO — `docker-compose.yml` in this repo spins up both locally
- A Qdrant instance (Cloud or self-hosted) if you want Ask-AI/semantic search
- One AI provider configured: a Gemini API key, an OpenAI API key, or a local Ollama install

## Getting started

```bash
# 1. Install JS dependencies
npm install

# 2. Start MinIO + Redis locally (or point at your own instances via .env)
docker compose up -d

# 3. Set up the Python transcription sub-module
cd python && python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt && cd ..

# 4. Create .env in the project root (see Environment variables below)

# 5. Run the API server only
npm run dev

# ...or run the API + all 7 workers together (needed for the full pipeline)
npm run dev:all

# 6. Seed the one admin account (requires ADMIN_EMAIL/ADMIN_PASSWORD in .env)
npm run create:admin
```

There's no in-app way to become an admin — `create:admin` is the only path, and it's idempotent (safe to re-run; promotes an existing user or no-ops if already admin).

## Environment variables

All variables are read once, centrally, in `src/config/envconfig.ts` — nothing else touches `process.env` directly. None of the values below are real secrets, just the variable names and their (dev-safe) defaults.

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | API server port |
| `MONGO_URI` | `mongodb://localhost:27017/media-processing` | |
| `REDIS_URL` | `redis://localhost:6379` | Shared by BullMQ and pipeline pub/sub |
| `MINIO_ENDPOINT` | `localhost` | |
| `MINIO_PORT` | `9000` | |
| `MINIO_ACCESS_KEY` | `minioadmin` | Change for anything beyond local dev |
| `MINIO_SECRET_KEY` | `minioadmin` | Change for anything beyond local dev |
| `MINIO_BUCKET` | `videos` | |
| `MINIO_PUBLIC_URL` | derived from endpoint/port | Base URL the frontend uses to fetch public HLS/thumbnail/transcript assets directly |
| `VIDEO_ENCODER` | auto-detected (`h264_nvenc` → `h264_videotoolbox` → `libx264`) | Force a specific FFmpeg encoder |
| `TRANSCODE_CONCURRENCY` | `2` | Renditions transcoded in parallel per job |
| `TRANSCODE_JOB_CONCURRENCY` | `2` | Videos transcoded in parallel across jobs |
| `AI_PROVIDER` | `ollama` (dev) / `gemini` (prod) | `gemini` \| `openai` \| `ollama` |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | — / `gemini-2.5-flash` | Required if `AI_PROVIDER=gemini` |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | — / `gpt-4o-mini` | Required if `AI_PROVIDER=openai` |
| `OLLAMA_ENDPOINT` / `OLLAMA_MODEL` | `http://localhost:11434` / `qwen3:4b` | Required if `AI_PROVIDER=ollama` |
| `QDRANT_URL` / `QDRANT_API_KEY` | — | Needed for embeddings/Ask-AI; side-branch is marked `skipped`-adjacent behavior degrades gracefully without it |
| `JWT_SECRET` | insecure dev default | **Must** be set for any non-local deployment |
| `JWT_EXPIRES_IN` | `7d` | |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | — | Only read by `npm run create:admin`; both required for that script to run |
| `DNS_SERVERS` | unset (no-op) | Comma-separated nameserver override for environments where Node's resolver can't do SRV lookups (e.g. some VPN/corporate networks) — only needed if `mongodb+srv://` or Redis/MinIO hostnames fail to resolve |

## npm scripts

| Script | Purpose |
|---|---|
| `npm run dev` | API server only, hot-reload |
| `npm run dev:all` | API server + all 7 workers together |
| `npm run worker:<name>` | Run a single worker in isolation (`inspection`, `planner`, `transcoder`, `thumbnail`, `transcript`, `ai`, `embedding`) |
| `npm run build` / `npm start` | Compile with `tsc`, then run the compiled output |
| `npm test` | Runs the `*.test.ts` files under `src/` with Node's built-in test runner |
| `npm run create:admin` | Seed/promote the single admin account from `.env` |
| `npm run clear:db` / `clear:redis` / `clear:minio` / `clear:qdrant` | Wipe one dependency's data — **destructive**, local/dev use only |
| `npm run clear:all` | Runs all of the above |

## API surface

All routes except `/health`, `/api/auth/register`, and `/api/auth/login` require a `Bearer` JWT.

**`/api/auth`**
- `POST /register`, `POST /login`
- `GET /me` — current user

**`/api/videos`** (owner-or-admin access per video)
- `GET /get-videos` — the caller's own videos
- `POST /initiate-upload` → reserves a record, returns a presigned MinIO PUT URL
- `POST /:videoId/complete-upload` → confirms the object landed, kicks off the pipeline
- `POST /:videoId/cancel-upload` → cancels a still-in-progress upload
- `POST /:videoId/retry/:stage` → retries a failed `transcript` / `ai` / `embedding` stage
- `GET /:videoId/play` → playback URL + status (200 when ready, 409 with progress info while processing)
- `POST /:videoId/ask` → RAG question-answering grounded in the video's transcript

**`/api/admin`** (admin role required)
- `GET /stats`, `GET /stats/stream` (SSE, live-updating)
- `GET /videos`, `GET /users`

**`GET /health`** — deep check (Mongo/Redis/MinIO reachability), no auth required.

## Data model

A single `Video` document (`src/models/video.model.ts`) is the source of truth, populated incrementally as it moves through the pipeline:

- **`status`** — the critical-path state machine: `uploading → uploaded → inspecting → inspected → planning → planned → transcoding → completed`, or `failed` (with a `failedStage`).
- **`transcript` / `aiSummary` / `vectorIndex`** — three independent side-branches, each `pending → processing → completed | failed | skipped`. A silent video (no speech) resolves the latter two to `skipped` rather than failing.

## Notes

- Uploads go directly from the browser to MinIO (presigned URL) — the API server never buffers or streams the raw file.
- There's exactly one admin account model: seeded via `create:admin`, no in-app promotion path.
- Everything under `hls/`, `thumbnail.jpg`, and `transcript.json` in the bucket is public-read (see `setPublicReadPolicy`); the original upload is not.
