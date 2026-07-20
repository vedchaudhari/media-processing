/**
 * Transcode-ladder planner.
 *
 * Pure function (no I/O): given a source's inspected metadata, decides which
 * HLS renditions to produce. Kept separate from the worker so the laddering
 * logic is unit-testable in isolation (see planner.service.test.ts).
 */
import type { IVideoMetadata, IVideoVariant } from "../models/video.model.js";

// Fixed bitrate presets per rendition height (bits per second).
const PRESETS: Record<number, number> = {
  2160: 12_000_000,
  1080: 5_000_000,
  720: 2_800_000,
  480: 1_200_000,
};

/**
 * Builds the rendition ladder for a video from its inspected metadata.
 *
 * Rules:
 * - Generate every preset rung at or below the original height (never upscale).
 * - Below 480p, generate a single "source only" variant at the original height,
 *   reusing the source bitrate (falling back to the lowest preset).
 *
 * @param metadata  Inspected source metadata; `height` is required.
 * @returns Variants ordered highest resolution first.
 * @throws  If `metadata.height` is missing (inspection must run first).
 */
export const planVariants = (metadata: IVideoMetadata): IVideoVariant[] => {
  const height = metadata.height;
  if (!height) {
    throw new Error("Cannot plan: metadata.height is missing");
  }

  // standard preset rungs at or below the original height, highest first
  const rungs = Object.keys(PRESETS)
    .map(Number)
    .filter((h) => h <= height)
    .sort((a, b) => b - a);

  if (rungs.length > 0) {
    return rungs.map((h) => ({ height: h, bitrate: PRESETS[h]! }));
  }

  // below 480: source-only variant at the original height
  return [{ height, bitrate: metadata.bitrate ?? PRESETS[480]! }];
};
