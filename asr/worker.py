import base64
import gc
import json
import os
import sys
import time

os.environ.setdefault("HF_HOME", "D:/hf_cache")
os.environ.setdefault("FASTEMBED_CACHE_PATH", "D:/hf_cache/fastembed")

# CTranslate2 loads CUDA DLLs lazily. Make an optional local CUDA install visible
# before importing faster_whisper, and keep the DLL directory handle alive.
cuda_dll_dir = os.environ.get("RECEIPTS_CUDA_DLL_DIR", "").strip()
cuda_dll_handle = None
if cuda_dll_dir:
    os.environ["PATH"] = cuda_dll_dir + os.pathsep + os.environ.get("PATH", "")
    if hasattr(os, "add_dll_directory"):
        try:
            cuda_dll_handle = os.add_dll_directory(cuda_dll_dir)
        except OSError as exc:
            print(json.dumps({"type": "status", "message": f"Could not add RECEIPTS_CUDA_DLL_DIR: {exc}"}), flush=True)

import numpy as np
from faster_whisper import WhisperModel

size = os.environ.get("RECEIPTS_ASR_MODEL", "small.en")
requested = os.environ.get("RECEIPTS_ASR_DEVICE", "cuda").strip().lower()
if requested not in ("cuda", "cpu"):
    raise ValueError("RECEIPTS_ASR_DEVICE must be either 'cuda' or 'cpu'")
download_root = os.path.join(os.environ["HF_HOME"], "faster-whisper")


def load_and_probe(device: str, compute_type: str):
    candidate = WhisperModel(size, device=device, compute_type=compute_type, download_root=download_root)
    # faster-whisper runs inference lazily. Consume the generator so CUDA kernels
    # and their runtime libraries are actually exercised before READY is emitted.
    silence = np.zeros(2 * 16000, dtype=np.float32)
    started = time.perf_counter()
    segments, _ = candidate.transcribe(silence, language="en", beam_size=1, vad_filter=False)
    list(segments)
    return candidate, (time.perf_counter() - started) * 1000.0


if requested == "cuda":
    try:
        model, probe_ms = load_and_probe("cuda", "float16")
        device = "cuda/float16"
    except Exception as exc:
        print(json.dumps({"type": "status", "message": f"CUDA inference probe failed; switching to CPU int8: {exc}"}), flush=True)
        gc.collect()
        model, probe_ms = load_and_probe("cpu", "int8")
        device = "cpu/int8"
else:
    model, probe_ms = load_and_probe("cpu", "int8")
    device = "cpu/int8"

try:
    from fastembed import TextEmbedding
    embedder = TextEmbedding(model_name="sentence-transformers/all-MiniLM-L6-v2")
    embedding_status = "sentence-transformers/all-MiniLM-L6-v2"
except ImportError:
    embedder = None
    embedding_status = "unavailable (install asr/requirements.txt)"

print(json.dumps({"type": "ready", "device": device, "probe_ms": probe_ms,
                  "embedding_model": embedding_status}), flush=True)

for line in sys.stdin:
    item = {}
    try:
        item = json.loads(line)
        if item["type"] == "transcribe":
            audio = np.frombuffer(base64.b64decode(item["pcm"]), dtype="<i2").astype(np.float32) / 32768.0
            started = time.perf_counter()
            segments, _ = model.transcribe(audio, language="en", beam_size=3, vad_filter=True)
            decoded = list(segments)
            rows = [{"start": item["start"] + segment.start, "end": item["start"] + segment.end,
                     "text": segment.text.strip(), "confidence": max(0.0, min(1.0, float(np.exp(segment.avg_logprob)) * (1.0 - segment.no_speech_prob)))}
                    for segment in decoded if segment.text.strip()]
            vectors = list(embedder.embed([row["text"] for row in rows])) if rows and embedder else []
            for row, vector in zip(rows, vectors):
                row["embedding"] = vector.tolist()
            elapsed_ms = (time.perf_counter() - started) * 1000.0
            print(json.dumps({"type": "transcript", "chunk_id": item["chunk_id"], "start": item["start"],
                              "duration": item["duration"], "elapsed_ms": elapsed_ms, "segments": rows}), flush=True)
        elif item["type"] == "embed":
            if embedder is None:
                raise RuntimeError("FastEmbed is missing; install the packages listed in asr/requirements.txt")
            started = time.perf_counter()
            vector = next(embedder.embed([item["text"]]))
            elapsed_ms = (time.perf_counter() - started) * 1000.0
            print(json.dumps({"type": "embedding", "request_id": item["request_id"],
                              "vector": vector.tolist(), "elapsed_ms": elapsed_ms}), flush=True)
    except Exception as exc:
        print(json.dumps({"type": "error", "message": str(exc), "request_id": item.get("request_id"),
                          "chunk_id": item.get("chunk_id"), "start": item.get("start")}), flush=True)
