import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Extracts a mono, 16kHz 16-bit PCM WAV file from the source video.
 * Whisper performs best with this specific format.
 */
export const extractAudio = (inputPath: string, outputPath: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-i", inputPath,
      "-vn",                  // disable video
      "-acodec", "pcm_s16le",  // 16-bit PCM
      "-ar", "16000",         // 16kHz sampling rate
      "-ac", "1",             // 1 channel (mono)
      "-y",                   // overwrite
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

/**
 * Spawns the python script using the isolated virtual environment.
 */
export const runTranscription = (
  audioPath: string,
  outputPath: string,
  model: string = "tiny"
): Promise<void> => {
  return new Promise((resolve, reject) => {
    // Cross-platform virtual env python binary path
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