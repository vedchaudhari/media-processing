import { execFileSync } from "node:child_process";

/**
 * Detects the best available FFmpeg H.264 encoder, preferring hardware
 * acceleration when the local ffmpeg build exposes it:
 *
 *   1. h264_nvenc        — NVIDIA GPU encoding (Linux/Windows boxes with NVENC)
 *   2. h264_videotoolbox — Apple VideoToolbox (macOS / Apple Silicon)
 *   3. libx264           — portable CPU software fallback
 *
 * Set VIDEO_ENCODER explicitly to override this (e.g. to force libx264 on a
 * machine whose ffmpeg advertises nvenc but has no usable GPU). Falls back to
 * libx264 if ffmpeg can't be probed at all (not on PATH), so the app still
 * starts instead of crashing on import.
 */
export const detectEncoder = (): string => {
  try {
    const encoders = execFileSync("ffmpeg", ["-hide_banner", "-encoders"], {
      encoding: "utf8",
    });

    if (encoders.includes("h264_nvenc")) {
      console.log("NVDIA found")
      return "h264_nvenc";
    }

    if (encoders.includes("h264_videotoolbox")) {
      console.log("MAC GPU found")
      return "h264_videotoolbox";
    }
  } catch {
    // ffmpeg missing or not probeable — fall through to the software encoder.
  }

  return "libx264";
};
