/**
 * ffprobe wrapper — extracts technical metadata from a local video file.
 *
 * Used by the inspection stage to learn a source's dimensions, codecs, fps,
 * duration, and bitrate, which the planner then uses to build the transcode
 * ladder.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IVideoMetadata } from "../models/video.model.js";

const execFileAsync = promisify(execFile);

/** Subset of ffprobe's per-stream JSON we care about (video or audio track). */
interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
}
/** Subset of ffprobe's top-level JSON output (`-show_format -show_streams`). */
interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: {
    duration?: string;
    bit_rate?: string;
  };
}

/**
 * Parses an ffprobe frame rate string (e.g. "30/1" or "30000/1001")
 * into a rounded frames-per-second number.
 */
const parseFrameRate = (rate: string): number | undefined => {
  const parts = rate.split("/");
  const num = Number(parts[0]);
  const den = Number(parts[1]);
  if (!num || !den) return undefined;
  return Math.round((num / den) * 100) / 100;
};

/**
 * Runs ffprobe on a local file and extracts video/audio metadata.
 *
 * Uses `execFile` (not a shell) since we only read metadata — no shell means
 * no shell-injection surface from the file path. Metadata is built
 * incrementally so optional fields are only set when ffprobe actually reports
 * them (we never store `undefined`).
 *
 * @param filePath  Absolute path to a locally-downloaded media file.
 * @returns Parsed metadata; fields are omitted when unavailable in the source.
 * @throws  If ffprobe isn't on PATH, the file is unreadable, or its output
 *          isn't valid JSON.
 */
export const inspectVideo = async (filePath: string): Promise<IVideoMetadata> => {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);

  console.log("Stdout from ffprobe:", stdout);

  const probe = JSON.parse(stdout) as FfprobeOutput;
  const streams = probe.streams ?? [];

  const videoStream = streams.find((s) => s.codec_type === "video");
  const audioStream = streams.find((s) => s.codec_type === "audio");

  // build incrementally so we never assign `undefined` to optional fields
  const metadata: IVideoMetadata = {};

  if (typeof videoStream?.width === "number") metadata.width = videoStream.width;
  if (typeof videoStream?.height === "number") metadata.height = videoStream.height;
  if (videoStream?.codec_name) metadata.videoCodec = videoStream.codec_name;
  if (audioStream?.codec_name) metadata.audioCodec = audioStream.codec_name;

  if (videoStream?.r_frame_rate) {
    const fps = parseFrameRate(videoStream.r_frame_rate);
    if (fps !== undefined) metadata.fps = fps;
  }

  if (probe.format?.duration) {
    const duration = Number.parseFloat(probe.format.duration);
    if (!Number.isNaN(duration)) metadata.duration = duration;
  }

  if (probe.format?.bit_rate) {
    const bitrate = Number.parseInt(probe.format.bit_rate, 10);
    if (!Number.isNaN(bitrate)) metadata.bitrate = bitrate;
  }

  return metadata;
};
