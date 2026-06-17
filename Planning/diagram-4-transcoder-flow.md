# Diagram 4 — Transcoder Worker Internal Flow

Detailed control flow of `src/workers/transcoder.worker.ts`, including the
parallel per-variant transcode, the all-or-nothing failure handling, and
cleanup. This is the most involved stage in the pipeline.

```mermaid
flowchart TD
    Start([job: transcode-video]) --> SetStatus[status = transcoding]
    SetStatus --> Guard{objectKey &<br/>variants present?}
    Guard -->|no| Throw1[throw 'not ready']
    Guard -->|yes| Download[download original.mp4<br/>to temp workDir]

    Download --> Fan[Promise.allSettled<br/>over all variants]

    subgraph PerVariant["each variant (parallel)"]
        direction TB
        V1[mkdir variantDir] --> V2[transcodeVariant<br/>ffmpeg → HLS]
        V2 --> V3[uploadDirectory<br/>track uploadedKeys]
        V3 --> V4[job.updateProgress]
    end

    Fan --> PerVariant
    PerVariant --> Check{any variant<br/>rejected?}

    Check -->|yes| Catch
    Check -->|no| Master[build master.m3u8]
    Master --> UploadMaster[upload master playlist<br/>track key]
    UploadMaster --> Complete[save streaming,<br/>status = completed]
    Complete --> Finally

    subgraph Catch["catch (rollback)"]
        R1[removeObjects uploadedKeys] --> R2[status = failed] --> R3[rethrow]
    end

    Throw1 --> Catch
    Catch --> Finally

    Finally[finally:<br/>rm workDir] --> End([done])
```

**Key design points**
- Uses `Promise.allSettled` (not `Promise.all`) so every variant finishes and
  `uploadedKeys` is fully populated before any rollback runs.
- Width per rendition is derived from the source aspect ratio and forced even
  (`widthFor`), because x264 requires even dimensions.
- All-or-nothing: if a single variant fails, the whole job fails and every
  uploaded object is removed — no half-published streams.
- `finally` always removes the temp working directory.
