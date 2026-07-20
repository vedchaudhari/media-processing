/**
 * FFmpeg transcoding primitives.
 *
 * Two responsibilities: build the per-variant HLS encode (encoder-aware, one
 * rendition at a time) and assemble the master playlist that ties the
 * renditions together. The transcoder worker orchestrates calls to these; the
 * ffmpeg-flag choices and their rationale live in the inline comments below.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { env } from "../config/envconfig.js";

/** Inputs for encoding one rendition; `segmentDuration` defaults to 6s. */
interface TranscodeVariantArgs {
  inputPath: string;
  outputDir: string;
  height: number;
  bitrate: number;
  segmentDuration?: number;
}

/**
 * Builds the encoder-specific FFmpeg args for one variant.
 *
 * - h264_nvenc: NVIDIA hardware encoding. Offloads the expensive encode to the
 *   GPU's dedicated encoder chip, so renditions can run in parallel without
 *   saturating the CPU. Uses NVENC preset `p4` (balanced) and VBR with a
 *   bitrate cap to mirror the software ladder.
 * - h264_videotoolbox: Apple hardware encoding (macOS / Apple Silicon). Uses
 *   the same bitrate cap, but takes NO libx264-style `-preset` — VideoToolbox
 *   rejects that option and ffmpeg would abort.
 * - libx264: CPU software encoding fallback (`fast` preset).
 *
 * Scaling stays on the CPU (`scale=-2:height`) in all cases — it's cheap
 * relative to encoding and keeps the pipeline portable.
 */
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

  // software fallback (libx264 or any other configured CPU encoder)
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

/**
 * Transcodes a single variant of a video into HLS (an .m3u8 playlist plus
 * .ts segments) with FFmpeg.
 *
 * Responsibility: ONE variant only. Uses spawn (not execFile) because
 * transcoding is long-running and streams progress/output to stderr.
 * Resolves on a clean exit (code 0), rejects otherwise.
 * 
 * @param args  Input path, output dir, target height/bitrate, segment length.
 * @returns Resolves when the HLS files are written to `outputDir`.
 * @throws  If ffmpeg can't be spawned or exits non-zero (message includes the
 *          tail of stderr).
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
      ...videoEncoderArgs(bitrate),
      // 8-bit 4:2:0 for the broadest player/HLS compatibility. Applied to ALL
      // encoders: a 10-bit source would otherwise make libx264 emit High 10
      // H.264, which browsers/MSE cannot decode (silent black-screen playback).
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      // Downmix to stereo. Source 5.1/multichannel AAC (esp. with an unknown
      // channel layout) fails to decode in browsers via MSE/hls.js, which
      // stalls playback (black screen). 2 channels is universally playable.
      "-ac",
      "2",
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

/** One rendition's descriptor for the master playlist (dimensions + bitrate). */
export interface MasterPlaylistEntry {
  height: number;
  width: number;
  bitrate: number;
}

/**
 * Builds an HLS master playlist that lists every rendition. Each entry points
 * at the variant's playlist via a relative path (`<height>p/playlist.m3u8`),
 * so the master must be uploaded at the root of the `hls/` prefix.
 * 
 * @returns The master `.m3u8` contents as a string (caller writes/uploads it).
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
