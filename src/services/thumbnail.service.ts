/**
 * Thumbnail generation — extracts a single poster frame from a video.
 *
 * Used by the (non-blocking) thumbnail worker: pick a representative timestamp,
 * then grab one JPEG frame at it. Kept encoder-agnostic and dependency-free so
 * it works on any host with ffmpeg.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Extracts a single frame from `inputPath` at `timestampSec` and writes
 * it to `outputPath` as a JPEG.
 *
 * Uses -vframes 1 (single frame) + -q:v 2 (high quality JPEG).
 * The scale filter caps the width at 640px, keeping aspect ratio.
 *
 * @param inputPath     Local path to the source video.
 * @param outputPath    Local path to write the JPEG to.
 * @param timestampSec  Seek position, in seconds (seeked before decode = fast).
 * @throws  If ffmpeg can't be spawned or exits non-zero.
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
 * Picks the timestamp to grab the thumbnail from.
 *
 * Targets 25% into the video — far enough past black intros/title cards to be
 * representative, without needing to decode the whole file. Clamps to
 * `duration - 0.1s` so we never seek past the end, and falls back to 0 when
 * duration is unknown.
 *
 * @param duration  Source duration in seconds (from ffprobe); optional.
 * @returns Seek position in seconds.
 */
export const pickTimestamp = (duration?: number): number => {
  if (!duration || duration <= 0) return 0;
  const target = duration * 0.25;
  return Math.min(target, duration - 0.1); // don't overshoot
};
