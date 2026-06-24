import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Extracts a single frame from `inputPath` at `timestampSec` and writes
 * it to `outputPath` as a JPEG.
 *
 * Uses -vframes 1 (single frame) + -q:v 2 (high quality JPEG).
 * The scale filter caps the width at 640px, keeping aspect ratio.
 */
export const extractThumbnail = async (
  inputPath: string,
  outputPath: string,
  timestampSec: number
): Promise<void> => {
  await execFileAsync("ffmpeg", [
    "-ss", String(timestampSec),     // seek first (fast)
    "-i", inputPath,
    "-vframes", "1",                 // single frame
    "-vf", "scale=640:-2",           // 640px wide, keep aspect, even height
    "-q:v", "2",                     // JPEG quality (2 = high)
    "-y",                            // overwrite
    outputPath,
  ]);
};

/**
 * Picks a timestamp for the thumbnail.
 * - Uses 25% of duration (avoids black intros/outros).
 * - Falls back to 0 if duration is missing.
 * - Clamps to at least 1s (if video is long enough) to skip fade-ins.
 */
export const pickTimestamp = (duration?: number): number => {
  if (!duration || duration <= 0) return 0;
  const target = duration * 0.25;
  return Math.min(target, duration - 0.1); // don't overshoot
};
