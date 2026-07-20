/**
 * Transcription pipeline glue — bridges ffmpeg and the Python Whisper script.
 *
 * Two steps the transcript worker calls in sequence: pull a Whisper-friendly
 * audio track out of the video, then hand that audio to faster-whisper (run in
 * its own Python virtualenv) to produce a timestamped transcript JSON.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Reports whether the source file contains at least one audio stream.
 *
 * Some videos (screen recordings, camera clips with the mic off) carry only a
 * video track. Feeding those to {@link extractAudio} makes ffmpeg fail with a
 * cryptic "Output file does not contain any stream" error, so callers probe
 * first and route audio-less inputs into the silent-video path instead.
 *
 * @param inputPath  Local path to the source video.
 * @returns  True if ffprobe finds an audio stream, false otherwise.
 * @throws   If ffprobe can't be spawned or exits non-zero.
 */
export const hasAudioStream = (inputPath: string): Promise<boolean> => {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "a",          // audio streams only
      "-show_entries", "stream=index", // print each matching stream's index
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

/**
 * Extracts a mono, 16kHz 16-bit PCM WAV file from the source video.
 *
 * Whisper is trained on exactly this format (mono / 16kHz), so feeding it the
 * same avoids resampling artifacts and gives the best transcription accuracy.
 *
 * @param inputPath   Local path to the source video.
 * @param outputPath  Local path to write the WAV to.
 * @throws  If ffmpeg can't be spawned or exits non-zero.
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
 * Runs the faster-whisper transcription script and writes its JSON output.
 *
 * Prefers the project's Python virtualenv interpreter (`python/.venv`) so the
 * pinned faster-whisper/CTranslate2 versions are used; falls back to a system
 * `python3` if the venv isn't present. The script's stdout is streamed to the
 * console for live progress; stderr is captured and surfaced on failure.
 *
 * @param audioPath   Local path to the extracted WAV audio.
 * @param outputPath  Local path the script writes the transcript JSON to.
 * @param model       Whisper model size (e.g. "tiny", "base"); defaults "tiny".
 * @throws  If Python can't be spawned or the script exits non-zero.
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