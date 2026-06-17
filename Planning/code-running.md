# Running the Pipeline — Start to End (curl)

End-to-end steps to process a video through the whole pipeline:
`uploaded → inspecting → inspected → planning → planned → transcoding → completed`.

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
```bash
curl http://localhost:3000/health
# expected: {"status":"okay"}
```

## 4. Initiate upload (returns videoId, objectKey, uploadUrl)
```bash
curl -s -X POST http://localhost:3000/api/videos/initiate-upload \
  -H "Content-Type: application/json" \
  -d '{"title":"my first video"}'
```
Example response:
```json
{
  "success": true,
  "videoId": "6a304291d3e6d24349f31688",
  "objectKey": "videos/<uuid>/original.mp4",
  "uploadUrl": "http://localhost:9000/videos/<uuid>/original.mp4?X-Amz-..."
}
```

## 5. Upload the actual video file (PUT to the presigned URL)
`--upload-file` makes it a PUT. Quote the URL (it has query params).
```bash
curl -X PUT --upload-file "/f/path/to/video.mp4" "<PASTE_uploadUrl_HERE>"
```

## 6. Complete the upload (starts the pipeline)
```bash
curl -X POST http://localhost:3000/api/videos/<PASTE_videoId_HERE>/complete-upload
# expected: {"success":true,"videoId":"...","status":"uploaded"}
```

---

## All-in-one (steps 4–6 with jq)
Set `FILE` to your video path, paste, and run:
```bash
FILE="/f/path/to/video.mp4"

RES=$(curl -s -X POST http://localhost:3000/api/videos/initiate-upload \
  -H "Content-Type: application/json" -d '{"title":"my first video"}')

VIDEO_ID=$(echo "$RES" | jq -r '.videoId')
UPLOAD_URL=$(echo "$RES" | jq -r '.uploadUrl')
echo "videoId: $VIDEO_ID"

curl -X PUT --upload-file "$FILE" "$UPLOAD_URL"
curl -X POST "http://localhost:3000/api/videos/$VIDEO_ID/complete-upload"
```

---

## 7. Watch it process (worker terminals)
After step 6, in order:
- inspection:  `Inspecting...` → `Inspected video: {...}`   (metadata)
- planner:     `Planning...`   → `Planned video: {...}`     (variants)
- transcoder:  `Transcoding...` → `Progress... 33% / 66% / 100%` → `Transcoded video: {...}`

## 8. Verify the result
No GET endpoint yet — check the outputs directly:
- MinIO (http://localhost:9001) → `videos/<uuid>/` has `original.mp4` + `1080p.mp4`, `720p.mp4`, `480p.mp4`
  (which renditions depend on the source resolution).
- MongoDB (Atlas → `videos` collection) → record at `status: "completed"` with
  `metadata`, `variants`, and `generatedFiles`.

---

## Troubleshooting
| Symptom | Cause |
|---|---|
| PUT → `NoSuchBucket` | `videos` bucket not created in MinIO |
| status stuck at `uploaded` | inspection worker not running / Redis unreachable |
| job fails with `ENOENT` | `ffmpeg` / `ffprobe` not on PATH |
| `ECONNREFUSED ...:9000` | MinIO not running (`docker compose up -d`) |
| `ECONNREFUSED ...:6379` | wrong/missing `REDIS_URL`, or managed Redis unreachable |
