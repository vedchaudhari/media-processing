# Running the Pipeline — Start to End (Postman)

End-to-end steps to process a video through the whole pipeline:
`uploaded → inspecting → inspected → planning → planned → transcoding → completed`.

API calls are done in Postman; the prerequisite/terminal commands stay in a
shell.

## 1. Prerequisites (one-time / per session)

Start MinIO (MongoDB + Redis are managed/cloud via `.env`):
```bash
docker compose up -d
```

Make sure FFmpeg + FFprobe are installed and on PATH:
```bash
ffmpeg -version
ffprobe -version
```

One-time: create the `videos` bucket in MinIO — open http://localhost:9001
(login `minioadmin` / `minioadmin`) → Create Bucket → name it `videos`.

## 2. Start the app (each in its own terminal)
```bash
npm run dev                  # API server  (http://localhost:3000)
npm run worker:inspection    # inspection worker
npm run worker:planner       # planner worker
npm run worker:transcoder    # transcoder worker
```

## 3. Health check
- Method: **GET**
- URL: `http://localhost:3000/health`
- Send → expected body: `{"status":"okay"}`

## 4. Initiate upload (returns videoId, objectKey, uploadUrl)
- Method: **POST**
- URL: `http://localhost:3000/api/videos/initiate-upload`
- Body → **raw** → type **JSON**:
  ```json
  { "title": "my first video" }
  ```
- Send. Example response:
  ```json
  {
    "success": true,
    "videoId": "6a304291d3e6d24349f31688",
    "objectKey": "videos/<uuid>/original.mp4",
    "uploadUrl": "http://localhost:9000/videos/<uuid>/original.mp4?X-Amz-..."
  }
  ```
- Copy `videoId` and `uploadUrl` for the next steps.

## 5. Upload the actual video file (PUT to the presigned URL)
- Method: **PUT**
- URL: paste the **`uploadUrl`** from step 4 whole (keep the `?X-Amz-...` query).
- Body → **binary** → **Select File** → pick your `.mp4`.
- Do NOT add a `Content-Type` header and do NOT use form-data — it must be the
  raw file as the body.
- Send → success is **200 OK** with an empty body.

## 6. Complete the upload (starts the pipeline)
- Method: **POST**
- URL: `http://localhost:3000/api/videos/<PASTE_videoId_HERE>/complete-upload`
- No body needed.
- Send → expected: `{"success":true,"videoId":"...","status":"uploaded"}`

---

## Tip: reuse `videoId` / `uploadUrl` automatically (optional)
In Postman you can avoid copy-pasting by saving response values into variables.
On the **step 4** request, add a **Scripts → Post-response** snippet:
```js
const res = pm.response.json();
pm.collectionVariables.set("videoId", res.videoId);
pm.collectionVariables.set("uploadUrl", res.uploadUrl);
```
Then in later requests use `{{videoId}}` and `{{uploadUrl}}` in the URL, e.g.
`http://localhost:3000/api/videos/{{videoId}}/complete-upload`.

---

## 7. Watch it process (worker terminals)
After step 6, in order:
- inspection:  `Inspecting...` → `Inspected video: {...}`   (metadata)
- planner:     `Planning...`   → `Planned video: {...}`     (variants)
- transcoder:  `Transcoding...` → `Progress... 33% / 66% / 100%` → `Transcoded video: {...}`

## 8. Verify the result
Check the outputs directly:
- MinIO (http://localhost:9001) → `videos/<uuid>/` has `original.mp4` plus an
  `hls/` tree: `hls/master.m3u8` and per-rendition `hls/720p/`, `hls/480p/` …
  (each with `playlist.m3u8` + `segment_*.ts`; which renditions depend on the
  source resolution).
- MongoDB (Atlas → `videos` collection) → record at `status: "completed"` with
  `metadata`, `variants`, `generatedFiles`, and `streaming.masterPlaylist`.

## 9. Get the playback URL
- Method: **GET**
- URL: `http://localhost:3000/api/videos/<PASTE_videoId_HERE>/play`
- Send. Example response:
  ```json
  {
    "success": true,
    "videoId": "6a304291d3e6d24349f31688",
    "status": "completed",
    "playbackUrl": "http://localhost:9000/videos/<uuid>/hls/master.m3u8"
  }
  ```
- If `status` isn't `completed` yet → `409` with the current status (still
  processing / failed).
- The HLS outputs are served public-read (the app sets this policy on startup),
  so the URL is directly fetchable — no signing needed. To confirm in Postman,
  do **GET** requests on:
  - `<playbackUrl>` → returns the master playlist (lists renditions)
  - `http://localhost:9000/videos/<uuid>/hls/720p/playlist.m3u8` → lists segments

If the master + a variant playlist come back as text (not `403`), HLS.js can
play the video by pointing at `playbackUrl`.

---

## Troubleshooting
| Symptom | Cause |
|---|---|
| PUT → `NoSuchBucket` | `videos` bucket not created in MinIO |
| status stuck at `uploaded` | inspection worker not running / Redis unreachable |
| job fails with `ENOENT` | `ffmpeg` / `ffprobe` not on PATH |
| `ECONNREFUSED ...:9000` | MinIO not running (`docker compose up -d`) |
| `ECONNREFUSED ...:6379` | wrong/missing `REDIS_URL`, or managed Redis unreachable |
| playback URL → `403` / `AccessDenied` | public-read policy not applied — restart the API (`npm run dev`) so startup re-applies it |
| `/play` → `409` | video not `completed` yet (or transcode failed) — check status/workers |