import argparse
import json
import os
import sys

import ctranslate2
# pyrefly: ignore [missing-import]
from faster_whisper import WhisperModel


def enable_cuda_dlls():
    """
    On Windows, the CUDA runtime libraries that CTranslate2 needs (cuBLAS,
    cuDNN, NVRTC) are shipped by the `nvidia-*-cu12` pip packages into
    `site-packages/nvidia/<lib>/bin`. Those dirs are NOT on the DLL search
    path, so a CUDA run fails at inference with e.g. "Library cublas64_12.dll
    is not found or cannot be loaded".

    CTranslate2's native loader resolves these transitive CUDA DLLs via the
    PATH environment variable, NOT via os.add_dll_directory — verified
    empirically: add_dll_directory alone still fails to find cublas64_12.dll,
    while prepending the bin dirs to PATH works. We do both (add_dll_directory
    for the modern loader, PATH for the native one) and cover every nvidia
    subpackage that ships a bin/ dir.

    No-op on Linux/macOS, where the loader uses LD_LIBRARY_PATH / rpath.
    """
    if not hasattr(os, "add_dll_directory"):
        return
    try:
        import nvidia
    except ImportError:
        return  # GPU libs not installed; we'll run on CPU
    for base in nvidia.__path__:
        if not os.path.isdir(base):
            continue
        for sub in os.listdir(base):
            bin_dir = os.path.join(base, sub, "bin")
            if os.path.isdir(bin_dir):
                os.add_dll_directory(bin_dir)
                os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")


def pick_device(requested: str) -> tuple[str, str]:
    """
    Resolves the (device, compute_type) pair to run the model with.

    - "cpu": forced CPU. float32 is the most stable/portable CPU setting.
    - "cuda"/"auto": use the GPU when CTranslate2 can see a CUDA device, with
      float16 (Tensor cores, half the VRAM). Falls back to CPU otherwise; an
      explicit "cuda" request that can't be honoured warns but still runs.
    """
    if requested == "cpu":
        return "cpu", "float32"

    try:
        has_cuda = ctranslate2.get_cuda_device_count() > 0
    except Exception:
        has_cuda = False

    if has_cuda:
        return "cuda", "float16"

    if requested == "cuda":
        print(
            "Warning: --device cuda requested but no CUDA device is visible; "
            "falling back to CPU.",
            file=sys.stderr,
            flush=True,
        )
    return "cpu", "float32"


def load_model(model_size: str, device: str, compute_type: str):
    """
    Loads the Whisper model, with a safety net: if a CUDA load fails at runtime
    (e.g. the cuDNN/cuBLAS libraries are missing or mismatched even though the
    driver is visible), degrade to CPU instead of failing the whole job.
    """
    try:
        return WhisperModel(model_size, device=device, compute_type=compute_type), device
    except Exception as exc:
        if device == "cuda":
            print(
                f"CUDA model load failed ({exc}); falling back to CPU.",
                file=sys.stderr,
                flush=True,
            )
            return WhisperModel(model_size, device="cpu", compute_type="float32"), "cpu"
        raise


def main():
    parser = argparse.ArgumentParser(description="Transcribe audio using faster-whisper")
    parser.add_argument("--input", required=True, help="Path to input audio file")
    parser.add_argument("--output", required=True, help="Path to save transcript JSON")
    parser.add_argument("--model", default="tiny", help="Whisper model size (e.g., tiny, base)")
    parser.add_argument(
        "--device",
        default="auto",
        choices=["auto", "cuda", "cpu"],
        help="Compute device: auto (GPU if available, else CPU), cuda, or cpu",
    )
    args = parser.parse_args()

    try:
        enable_cuda_dlls()
        device, compute_type = pick_device(args.device)

        print(
            f"Loading Whisper model '{args.model}' on {device} ({compute_type})...",
            flush=True,
        )
        model, device = load_model(args.model, device, compute_type)

        print("Transcribing...", flush=True)
        segments, info = model.transcribe(args.input, beam_size=5)

        results = []
        full_text = []
        for segment in segments:
            results.append({
                "start": round(segment.start, 2),
                "end": round(segment.end, 2),
                "text": segment.text.strip()
            })
            full_text.append(segment.text.strip())
            # Stream progress to console
            print(f"[{segment.start:.2f}s -> {segment.end:.2f}s] {segment.text}", flush=True)

        output_data = {
            "text": " ".join(full_text),
            "segments": results,
            "language": info.language,
            "language_probability": info.language_probability
        }

        with open(args.output, "w", encoding="utf-8") as f:
            json.dump(output_data, f, ensure_ascii=False, indent=2)

        print(f"Transcription saved to {args.output}", flush=True)
    except Exception as e:
        print(f"Error during transcription: {e}", file=sys.stderr, flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
