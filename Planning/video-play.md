# Playback Endpoint — Plan (easiest path)

Goal: get a finished video playing in HLS.js. Backend only for now.

```
Upload → Inspect → Plan → Transcode → Playback
```
```
videoId → GET /videos/:id/play → backend returns master playlist URL → HLS.js plays it
```

---

## What we already have

The transcoder already wrote a full HLS tree to MinIO and recorded it on the
Video doc — playback is pure read, no queue/worker:

```
videos/<uuid>/hls/master.m3u8          # master playlist (references children by RELATIVE path)
videos/<uuid>/hls/720p/playlist.m3u8
videos/<uuid>/hls/720p/segment_000.ts
videos/<uuid>/hls/480p/playlist.m3u8
...
```
DB (`src/models/video.model.ts`): `status` (`"completed"` gates playback) and
`streaming.masterPlaylist` (e.g. `videos/<uuid>/hls/master.m3u8`).

---

## Approach: public-read on the `hls/` prefix

HLS references its children by **relative** path, so a presigned master URL
won't work (the `?signature` is dropped when the player resolves
`720p/playlist.m3u8`, and segment requests 403). Easiest fix: make the HLS
objects publicly GET-able and return the plain public URL. Relative children
resolve to public URLs and just work.

- Keep `original.mp4` private; only `*/hls/*` is public.
- No expiry / no access control for now — fine to get HLS.js running.

---

## Implementation

### 1. One-time MinIO setup: public-read on the `hls/` objects
Set a bucket policy on `videos` allowing anonymous `s3:GetObject` for
`videos/*/hls/*` only (NOT `original.mp4`).

Either via the MinIO console (Buckets → videos → Access → add an Anonymous
prefix rule for `*/hls/`), or programmatically at startup with
`minioClient.setBucketPolicy(VIDEO_BUCKET, policyJson)`. The policy:
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "AWS": ["*"] },
    "Action": ["s3:GetObject"],
    "Resource": ["arn:aws:s3:::videos/*/hls/*"]
  }]
}
```
Decide later whether to bake this into `src/startup` (alongside bucket
creation) so it's reproducible — for now the console is fine.

### 2. Build the public base URL
Public object URL = `http://<MINIO_ENDPOINT>:<PORT>/<bucket>/<objectKey>`.
Add a small config value (e.g. `MINIO_PUBLIC_URL=http://localhost:9000`) rather
than hardcoding, so it's easy to change. Master URL =
`${MINIO_PUBLIC_URL}/${VIDEO_BUCKET}/${streaming.masterPlaylist}`.

### 3. Controller: `getPlay` (`src/controllers/video.controller.ts`)
- Validate `videoId` is a valid ObjectId → else `400`.
- `Video.findById(videoId)` → none → `404`.
- `status !== "completed"` → `409 { status }` (still processing / failed).
- `!streaming?.masterPlaylist` → `409` (defensive).
- `200`:
  ```json
  {
    "success": true,
    "videoId": "<id>",
    "status": "completed",
    "playbackUrl": "http://localhost:9000/videos/<uuid>/hls/master.m3u8"
  }
  ```

### 4. Route (`src/routes/video.routes.ts`)
```ts
router.get("/:videoId/play", getPlay);
```

### 5. Manual test (curl)
```bash
curl -s http://localhost:3000/api/videos/<id>/play          # get playbackUrl
curl -s "<playbackUrl>"                                       # master, lists 720p/480p
curl -s "http://localhost:9000/videos/<uuid>/hls/720p/playlist.m3u8"  # lists segments
```
If the master + a variant playlist + a segment all return over plain HTTP,
HLS.js will play it by pointing at `playbackUrl`.

---

## Edge cases
| Video state | Response |
|---|---|
| id not a valid ObjectId | `400` |
| no such video | `404` |
| status not `completed` | `409 { status }` |
| completed, master missing | `409` (defensive) |
| completed, all good | `200 { playbackUrl }` |

## Out of scope (later)
- HLS.js frontend wiring (next step, separate).
- Access control / private playback (backend proxy or presigned-rewrite).
- CDN.
