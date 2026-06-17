# Diagram 2 — End-to-End Pipeline Sequence

Time-ordered view of a single video moving from upload to a completed HLS
stream. Each worker updates the `Video.status`, does its work, then hands off to
the next queue.

```mermaid
sequenceDiagram
    actor C as Client
    participant API as API (controller)
    participant DB as MongoDB
    participant S as MinIO
    participant IQ as inspection queue
    participant IW as inspection.worker
    participant PQ as planner queue
    participant PW as planner.worker
    participant TQ as transcoder queue
    participant TW as transcoder.worker

    C->>API: POST /initiate-upload {title}
    API->>DB: create Video (status: uploading)
    API->>S: presignedPutObject(objectKey)
    API-->>C: { videoId, objectKey, uploadUrl }
    C->>S: PUT original.mp4 (direct upload)

    C->>API: POST /:videoId/complete-upload
    API->>DB: status = uploaded
    API->>IQ: add "inspect-video"
    API-->>C: { videoId, status }

    IQ->>IW: job {videoId, objectKey}
    IW->>DB: status = inspecting
    IW->>S: download original.mp4
    IW->>IW: ffprobe → metadata
    IW->>DB: save metadata, status = inspected
    IW->>PQ: add "plan-video"

    PQ->>PW: job {videoId}
    PW->>DB: status = planning
    PW->>PW: planVariants(metadata)
    PW->>DB: save variants, status = planned
    PW->>TQ: add "transcode-video"

    TQ->>TW: job {videoId}
    TW->>DB: status = transcoding
    TW->>S: download original.mp4
    par For each variant (parallel)
        TW->>TW: ffmpeg → HLS segments
        TW->>S: upload <height>p/ folder
    end
    TW->>S: upload master.m3u8
    TW->>DB: save streaming, status = completed
```
