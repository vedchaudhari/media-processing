import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const hasAudioStream = (inputPath: string): Promise<boolean> => {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "a",
      "-show_entries", "stream=index",
      "-of", "csv=p=0",
      inputPath,
    ]);

    let stdout = "";
    let stderr = "";
    ffprobe.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    ffprobe.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    ffprobe.on("error", reject);
    ffprobe.on("close", (code) => {
      if (code === 0) resolve(stdout.trim().length > 0);
      else reject(new Error(`ffprobe failed (code ${code}): ${stderr}`));
    });
  });
};

export const extractAudio = (inputPath: string, outputPath: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-i", inputPath,
      "-vn",
      "-acodec", "pcm_s16le",
      "-ar", "16000",
      "-ac", "1",
      "-y",
      outputPath,
    ]);

    let stderr = "";
    ffmpeg.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg audio extraction failed (code ${code}): ${stderr}`));
    });
  });
};

export const runTranscription = (
  audioPath: string,
  outputPath: string,
  model: string = "tiny"
): Promise<void> => {
  return new Promise((resolve, reject) => {

    const venvPython =
      process.platform === "win32"
        ? path.join(process.cwd(), "python", ".venv", "Scripts", "python.exe")
        : path.join(process.cwd(), "python", ".venv", "bin", "python");

    const pythonExecutable = fs.existsSync(venvPython) ? venvPython : "python3";
    const scriptPath = path.join(process.cwd(), "python", "transcribe.py");

    const python = spawn(pythonExecutable, [
      scriptPath,
      "--input", audioPath,
      "--output", outputPath,
      "--model", model,
    ]);

    let stderr = "";
    python.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    python.stdout.on("data", (chunk) => {
      console.log(`[Whisper Python]: ${chunk.toString().trim()}`);
    });

    python.on("error", reject);
    python.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`python transcribe.py failed (code ${code}): ${stderr}`));
    });
  });
};