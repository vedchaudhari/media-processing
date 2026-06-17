# Diagram 3 — Video Status State Machine

The `status` field on the `Video` document (see `src/models/video.model.ts`)
acts as a state machine threaded through the whole pipeline. Any stage can
transition to `failed` on error; the worker `catch` blocks set it and rethrow so
BullMQ records the job failure.

```mermaid
stateDiagram-v2
    [*] --> uploading: initiate-upload creates record

    uploading --> uploaded: complete-upload
    uploaded --> inspecting: inspection.worker picks up
    inspecting --> inspected: ffprobe metadata saved
    inspected --> planning: planner.worker picks up
    planning --> planned: rendition ladder saved
    planned --> transcoding: transcoder.worker picks up
    transcoding --> completed: master + variants uploaded

    completed --> [*]

    uploading --> failed: error
    inspecting --> failed: error
    planning --> failed: error
    transcoding --> failed: error (uploads rolled back)
    failed --> [*]
```

**Notes**
- `uploading → uploaded` is the only transition driven by the API; everything
  after is driven by workers.
- On `transcoding → failed`, the transcoder rolls back partial uploads
  (`removeObjects(uploadedKeys)`) before marking the video failed — all-or-nothing.
