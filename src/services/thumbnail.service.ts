import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const extractThumbnail = async (
  inputPath: string,
  outputPath: string,
  timestampSec: number
): Promise<void> => {
  await execFileAsync("ffmpeg", [
    "-ss", String(timestampSec),
    "-i", inputPath,
    "-vframes", "1",
    "-vf", "scale=640:-2",
    "-q:v", "2",
    "-y",
    outputPath,
  ]);
};

export const pickTimestamp = (duration?: number): number => {
  if (!duration || duration <= 0) return 0;
  const target = duration * 0.25;
  return Math.min(target, duration - 0.1);
};
