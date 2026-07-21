/**
 * Maps the video's current pipeline stage to a single 0–100 "overall progress"
 * number spanning the whole main pipeline (upload → inspection → planning →
 * transcoding → completed).
 *
 * Before this existed, `progress` only moved during transcoding — every
 * earlier stage silently reported 0%, which reads as "stuck" on the frontend
 * even though the video is actively being worked on. Each worker calls this
 * instead of inventing its own number, so the weighting only lives in one place.
 */
import type { VideoStatus } from "../models/video.model.js";

// Where each non-transcoding stage lands on the 0–100 scale. Transcoding gets
// the largest span (it's by far the slowest stage) and is interpolated below
// rather than fixed, since it already reports its own sub-progress.
const STAGE_PROGRESS: Record<Exclude<VideoStatus, "transcoding">, number> = {
  uploading: 0,
  uploaded: 2,
  inspecting: 5,
  inspected: 10,
  planning: 12,
  planned: 15,
  completed: 100,
  failed: 0, // failed is never computed — callers leave progress at its last value
};

const TRANSCODING_START = 15;
const TRANSCODING_END = 95;

/**
 * @param status            The video's current status.
 * @param transcodeProgress 0–100 completion of the transcoding stage itself
 *                          (fraction of variants encoded so far). Ignored
 *                          unless `status === "transcoding"`.
 */
export const computeOverallProgress = (
  status: VideoStatus,
  transcodeProgress = 0
): number => {
  if (status === "transcoding") {
    const clamped = Math.max(0, Math.min(100, transcodeProgress));
    return Math.round(
      TRANSCODING_START + (clamped / 100) * (TRANSCODING_END - TRANSCODING_START)
    );
  }
  return STAGE_PROGRESS[status];
};
