import argparse
import json
import sys
# pyrefly: ignore [missing-import]
from faster_whisper import WhisperModel
def main():
    parser = argparse.ArgumentParser(description="Transcribe audio using faster-whisper")
    parser.add_argument("--input", required=True, help="Path to input audio file")
    parser.add_argument("--output", required=True, help="Path to save transcript JSON")
    parser.add_argument("--model", default="tiny", help="Whisper model size (e.g., tiny, base)")
    args = parser.parse_args()

    try:
        print(f"Loading Whisper model '{args.model}'...", flush=True)
        # Using CPU and float32 is the most stable setting for macOS and general CPU environments
        model = WhisperModel(args.model, device="cpu", compute_type="float32")
        
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
