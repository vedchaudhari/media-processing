import type { VideoStatus } from "../models/video.types.js";

const STAGE_PROGRESS: Record<Exclude<VideoStatus, "transcoding">, number> = {
  uploading: 0,
  uploaded: 2,
  inspecting: 5,
  inspected: 10,
  planning: 12,
  planned: 15,
  completed: 100,
  failed: 0,
};

const TRANSCODING_START = 15;
const TRANSCODING_END = 95;

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
