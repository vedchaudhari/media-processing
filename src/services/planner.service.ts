import type { IVideoMetadata, IVideoVariant } from "../models/video.types.js";

const PRESETS: Record<number, number> = {
  2160: 12_000_000,
  1080: 5_000_000,
  720: 2_800_000,
  480: 1_200_000,
};

export const planVariants = (metadata: IVideoMetadata): IVideoVariant[] => {
  const height = metadata.height;
  if (!height) {
    throw new Error("Cannot plan: metadata.height is missing");
  }

  const rungs = Object.keys(PRESETS)
    .map(Number)
    .filter((h) => h <= height)
    .sort((a, b) => b - a);

  if (rungs.length > 0) {
    return rungs.map((h) => ({ height: h, bitrate: PRESETS[h]! }));
  }

  return [{ height, bitrate: metadata.bitrate ?? PRESETS[480]! }];
};
