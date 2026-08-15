import { execFileSync } from "node:child_process";

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

  }

  return "libx264";
};
