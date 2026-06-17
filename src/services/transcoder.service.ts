import { spawn } from "node:child_process";

interface TranscodeVariantArgs {
  inputPath: string;
  outputPath: string;
  height: number;
  bitrate: number;
}

/**
 * Transcodes a single variant of a video with FFmpeg.
 *
 * Responsibility: ONE variant only. Uses spawn (not execFile) because
 * transcoding is long-running and streams progress/output to stderr.
 * Resolves on a clean exit (code 0), rejects otherwise.
 */
export const transcodeVariant = ({
  inputPath,
  outputPath,
  height,
  bitrate,
}: TranscodeVariantArgs): Promise<void> => {
  return new Promise((resolve, reject) => {
    const args = [
      "-i",
      inputPath,
      "-vf",
      `scale=-2:${height}`, // keep aspect ratio; width auto-computed, kept even
      "-c:v",
      "libx264",
      "-b:v",
      String(bitrate),
      "-maxrate",
      String(bitrate),
      "-bufsize",
      String(bitrate * 2),
      "-preset",
      "fast",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      "-y",
      outputPath,
    ];

    const ffmpeg = spawn("ffmpeg", args);

    let stderr = "";
    ffmpeg.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    // fires if the ffmpeg binary cannot be spawned (e.g. not on PATH)
    ffmpeg.on("error", reject);

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(`ffmpeg exited with code ${code} for ${height}p: ${stderr.slice(-500)}`)
        );
      }
    });
  });
};
