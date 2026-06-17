import { spawn } from "node:child_process";
import path from "node:path";

interface TranscodeVariantArgs {
  inputPath: string;
  outputDir: string;
  height: number;
  bitrate: number;
  segmentDuration?: number;
}

/**
 * Transcodes a single variant of a video into HLS (an .m3u8 playlist plus
 * .ts segments) with FFmpeg.
 *
 * Responsibility: ONE variant only. Uses spawn (not execFile) because
 * transcoding is long-running and streams progress/output to stderr.
 * Resolves on a clean exit (code 0), rejects otherwise.
 */
export const transcodeVariant = ({
  inputPath,
  outputDir,
  height,
  bitrate,
  segmentDuration = 6,
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
      // HLS output: a VOD playlist referencing fixed-duration .ts segments
      "-hls_time",
      String(segmentDuration),
      "-hls_playlist_type",
      "vod",
      "-hls_segment_filename",
      path.join(outputDir, "segment_%03d.ts"),
      "-y",
      path.join(outputDir, "playlist.m3u8"),
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

export interface MasterPlaylistEntry {
  height: number;
  width: number;
  bitrate: number;
}

/**
 * Builds an HLS master playlist that lists every rendition. Each entry points
 * at the variant's playlist via a relative path (`<height>p/playlist.m3u8`),
 * so the master must be uploaded at the root of the `hls/` prefix.
 */
export const buildMasterPlaylist = (entries: MasterPlaylistEntry[]): string => {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3"];
  for (const { height, width, bitrate } of entries) {
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${bitrate},RESOLUTION=${width}x${height}`
    );
    lines.push(`${height}p/playlist.m3u8`);
  }
  return lines.join("\n") + "\n";
};
