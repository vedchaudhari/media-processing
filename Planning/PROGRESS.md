# Project Progress Report

> Status snapshot of the **media-processing** pipeline (backend) and
> **media-processing-website** (frontend) as of **2026-06-21**.

---

## At a glance

| Area                           | Status              | Approx. complete |
| ------------------------------ | ------------------- | ---------------- |
| Backend — core pipeline        | ✅ Completed        | 100%             |
| Backend — production hardening | ✅ Mostly done       | ~80%             |
| Frontend — full dashboard      | ✅ Built end-to-end  | ~95%             |
| Tests                          | 🟡 Basic unit tests  | ~25%             |
| Infrastructure / local dev     | 🟡 Partial           | ~65%             |
| Auth / deployment              | ❌ Not started       | 0%               |
| **Overall project**            | ✅ **Functional end-to-end; auth + deploy remain** | **~85%** |

The app now works **end to end**: upload a video on the website → watch its status advance live (with a transcode % bar) → play the finished adaptive HLS stream alongside an interactive, synced transcript. Remaining work is **auth, deployment, and broader test coverage**.

---

## ✅ Completed

### Backend — core pipeline
- [x] TypeScript/ESM project, `tsx` dev runner, API + 5 worker processes (`dev:all`).
- [x] Config layer: typed `env`, MongoDB, Redis (BullMQ-ready), MinIO, queue defaults.
- [x] `Video` model with full status state machine + `progress` field.
- [x] Upload API: `initiate-upload` (presigned PUT), `complete-upload` (atomic claim + storage verification), `get-videos`, `:id/play`.
- [x] Queues + workers: inspection (ffprobe) → planner (renditions) → transcoder (FFmpeg → HLS → MinIO) with retry/backoff.
- [x] Startup tasks: ensure bucket + public-read policies for HLS, thumbnails, and transcripts.
- [x] Transcode progress persisted + exposed; GPU (`h264_nvenc`) encoding; stereo audio downmix.
- [x] Thumbnail generation (asynchronous JPEG extraction at 25% of duration, uploaded and stored).
- [x] Automatic transcription pipeline (isolated Python venv, `faster-whisper` on extracted mono WAV, uploaded JSON, interactive synced UI).

### Backend — production hardening (this round)
- [x] **ObjectId validation** in `complete-upload` (bad id → 400, not 500).
- [x] **`status` enum** enforced at the schema level (single source of truth
      shared with the TS union via `VIDEO_STATUSES`).
- [x] **`-pix_fmt yuv420p` for all encoders** (software path no longer risks
      unplayable 10-bit output).
- [x] **Bounded transcode concurrency** (`TRANSCODE_CONCURRENCY`, default 2) —
      respects NVENC session limits / avoids CPU saturation.
- [x] **Rollback hardening** — cleanup failure no longer masks the real error
      or skips marking the video failed.
- [x] **Graceful shutdown** for API + all 3 workers (drain in-flight job,
      disconnect Mongo/Redis, force-exit safety timer).
- [x] **Deep `/health`** — checks MongoDB, Redis, and MinIO; returns 503 if any
      dependency is down.

### Frontend — full dashboard
- [x] API client (`lib/api.ts`) wrapping all endpoints + XHR presigned upload.
- [x] Shared types + react-query provider + app layout with nav.
- [x] **Upload page** — real 3-step flow with a live upload progress bar.
- [x] **Library page** — video grid with status badges, polling while anything
      is in progress, empty/loading/error states.
- [x] **Player page** — `hls.js` (with native-HLS fallback + cleanup),
      processing/failed states, transcode % bar.

### Tests
- [x] Unit tests (Node test runner via `tsx`): planner ladder rules +
      master-playlist builder. `npm test` → 10 passing.

---

## 🟡 In progress / partial

- [ ] **Broader test coverage** — only pure-logic units are covered; no
      integration tests for the API or workers yet (ffprobe/transcode need a
      test harness with the binaries + a test MinIO/Mongo/Redis).
- [ ] **Local dev story** — only MinIO is in docker-compose; Mongo/Redis are
      cloud, FFmpeg must be on the host (undocumented). Consider a full compose.
- [ ] **MinIO CORS** — the browser presigned PUT may need a bucket CORS rule;
      verify against a running MinIO and document the config step.

---

## ❌ Not started (need decisions from you)

- [ ] **Authentication / authorization** — every endpoint is currently open.
      (Decision needed: session/JWT? which provider?)
- [ ] **Deployment** — Docker images for API + workers, env/secret management,
      hosting target. (Decision needed: where does this run?)
- [ ] **Delete / retry endpoints** — no way to remove a video or requeue a
      `failed` one yet.
- [ ] **Secrets** — `.env` holds live cloud credentials; MinIO uses default
      creds. Rotate + move to a secret manager before sharing/deploying.

---

## Suggested next steps
1. **Auth** — gate the API + website (biggest remaining functional gap).
2. **Deployment config** — Dockerize API + workers; manage env/secrets.
3. **Delete + retry endpoints** — round out the lifecycle (UI is ready for them).
4. **Integration tests** + a full local `docker-compose` (Mongo + Redis + MinIO).

---

## Definition of "done" (target)
A user can open the website, upload a video, watch its status advance live (with
a progress bar during transcoding), and play the finished adaptive-bitrate
video — on a **secured, deployable** stack with tests in place. Core experience
is ✅ done; **security + deployment** are what's left.
