import base64
import json
import os
import sys
import time

os.environ.setdefault("HF_HOME", "D:/hf_cache")
os.environ.setdefault("FASTEMBED_CACHE_PATH", "D:/hf_cache/fastembed")

import numpy as np
from faster_whisper import WhisperModel

size = os.environ.get("RECEIPTS_ASR_MODEL", "small.en")
requested = os.environ.get("RECEIPTS_GPU", "cuda")
download_root = os.path.join(os.environ["HF_HOME"], "faster-whisper")
try:
    if requested == "cpu":
        raise RuntimeError("CPU explicitly selected")
    model = WhisperModel(size, device="cuda", compute_type="float16", download_root=download_root)
    device = "cuda/float16"
except Exception:
    print(json.dumps({"type": "status", "message": "Using CPU int8 fallback"}), flush=True)
    model = WhisperModel(size, device="cpu", compute_type="int8", download_root=download_root)
    device = "cpu/int8"

try:
    from fastembed import TextEmbedding
    embedder = TextEmbedding(model_name="sentence-transformers/all-MiniLM-L6-v2")
    embedding_status = "sentence-transformers/all-MiniLM-L6-v2"
except ImportError:
    embedder = None
    embedding_status = "unavailable (install asr/requirements.txt)"
print(json.dumps({"type": "ready", "device": device, "embedding_model": embedding_status}), flush=True)

for line in sys.stdin:
    try:
        item = json.loads(line)
        if item["type"] == "transcribe":
            audio = np.frombuffer(base64.b64decode(item["pcm"]), dtype="<i2").astype(np.float32) / 32768.0
            segments, _ = model.transcribe(audio, language="en", beam_size=3, vad_filter=True)
            rows = [{"start": item["start"] + s.start, "end": item["start"] + s.end,
                     "text": s.text.strip(), "confidence": max(0.0, min(1.0, float(np.exp(s.avg_logprob)) * (1.0 - s.no_speech_prob)))}
                    for s in segments if s.text.strip()]
            vectors = list(embedder.embed([row["text"] for row in rows])) if rows and embedder else []
            for row, vector in zip(rows, vectors):
                row["embedding"] = vector.tolist()
            print(json.dumps({"type": "transcript", "start": item["start"], "segments": rows}), flush=True)
        elif item["type"] == "embed":
            if embedder is None:
                raise RuntimeError("FastEmbed is missing; install the packages listed in asr/requirements.txt")
            start = time.perf_counter()
            vector = next(embedder.embed([item["text"]]))
            elapsed_ms = (time.perf_counter() - start) * 1000.0
            print(json.dumps({"type": "embedding", "request_id": item["request_id"],
                              "vector": vector.tolist(), "elapsed_ms": elapsed_ms}), flush=True)
    except Exception as exc:
        print(json.dumps({"type": "error", "message": str(exc), "request_id": item.get("request_id"), "start": item.get("start")}), flush=True)
