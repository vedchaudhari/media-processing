import { spawn } from "node:child_process";
import path from "node:path";
import { env } from "../config/envconfig.js";

interface TranscodeVariantArgs {
  inputPath: string;
  outputDir: string;
  height: number;
  bitrate: number;
  segmentDuration?: number;
}

const videoEncoderArgs = (bitrate: number): string[] => {
  const encoder = env.transcode.videoEncoder;
  const rate = String(bitrate);
  const bufsize = String(bitrate * 2);

  if (encoder === "h264_nvenc") {
    return [
      "-c:v",
      "h264_nvenc",
      "-preset",
      "p4",
      "-rc",
      "vbr",
      "-b:v",
      rate,
      "-maxrate",
      rate,
      "-bufsize",
      bufsize,
    ];
  }

  if (encoder === "h264_videotoolbox") {
    return [
      "-c:v",
      "h264_videotoolbox",
      "-b:v",
      rate,
      "-maxrate",
      rate,
      "-bufsize",
      bufsize,
    ];
  }

  return [
    "-c:v",
    encoder,
    "-b:v",
    rate,
    "-maxrate",
    rate,
    "-bufsize",
    bufsize,
    "-preset",
    "fast",
  ];
};

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
      `scale=-2:${height}`,
      ...videoEncoderArgs(bitrate),

      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",

      "-ac",
      "2",

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
