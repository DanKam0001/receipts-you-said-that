import base64
import gc
import json
import os
import sys
import time

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
skip_asr = os.environ.get("RECEIPTS_SKIP_ASR") == "1"
if skip_asr:
    model, probe_ms, device = None, 0.0, "asr-skipped"
else:
    from faster_whisper import WhisperModel

    size = os.environ.get("RECEIPTS_ASR_MODEL", "small.en")
    requested = os.environ.get("RECEIPTS_ASR_DEVICE", "cuda").strip().lower()
    if requested not in ("cuda", "cpu"):
        raise ValueError("RECEIPTS_ASR_DEVICE must be either 'cuda' or 'cpu'")
    download_root = os.path.join(os.environ["HF_HOME"], "faster-whisper") if os.environ.get("HF_HOME") else None

    def load_and_probe(device: str, compute_type: str):
        options = {"device": device, "compute_type": compute_type}
        if download_root: options["download_root"] = download_root
        candidate = WhisperModel(size, **options)
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

verifier = None
tokenizer = None
label_indices = None
nli_status = "unavailable"
nli_probe_ms = None
try:
    import onnxruntime as ort
    from tokenizers import Tokenizer
    from huggingface_hub import snapshot_download

    nli_path = snapshot_download(
        repo_id="Xenova/nli-deberta-v3-small",
        allow_patterns=["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"],
        cache_dir=os.path.join(os.environ["HF_HOME"], "hub") if os.environ.get("HF_HOME") else None,
        local_files_only=os.environ.get("HF_HUB_OFFLINE") == "1",
    )
    with open(os.path.join(nli_path, "config.json"), "r", encoding="utf-8") as config_file:
        config = json.load(config_file)
    id2label = {int(index): str(label).upper() for index, label in config["id2label"].items()}
    label_indices = {}
    for index, label in id2label.items():
        for wanted in ("CONTRADICTION", "ENTAILMENT", "NEUTRAL"):
            if wanted in label:
                label_indices[wanted.lower()] = index
    if set(label_indices) != {"contradiction", "entailment", "neutral"}:
        raise ValueError(f"NLI config id2label does not define contradiction/entailment/neutral: {id2label}")
    tokenizer = Tokenizer.from_file(os.path.join(nli_path, "tokenizer.json"))
    tokenizer.enable_truncation(max_length=512)
    verifier = ort.InferenceSession(os.path.join(nli_path, "onnx", "model_quantized.onnx"), providers=["CPUExecutionProvider"])
    probe = tokenizer.encode("A person is reading indoors.", "Someone is reading inside.", add_special_tokens=True)
    probe_inputs = {entry.name for entry in verifier.get_inputs()}
    probe_feeds = {"input_ids": np.asarray([probe.ids], dtype=np.int64),
                   "attention_mask": np.asarray([probe.attention_mask], dtype=np.int64),
                   "token_type_ids": np.asarray([probe.type_ids], dtype=np.int64)}
    probe_started = time.perf_counter()
    verifier.run(None, {name: probe_feeds[name] for name in probe_inputs if name in probe_feeds})
    nli_probe_ms = (time.perf_counter() - probe_started) * 1000.0
    nli_status = f"Xenova/nli-deberta-v3-small (CPU, cached/offline; warm-up {nli_probe_ms:.2f}ms/pair)"
except Exception as exc:
    print(json.dumps({"type": "status", "message": f"Local NLI verifier unavailable: {exc}"}), flush=True)

print(json.dumps({"type": "ready", "device": device, "probe_ms": probe_ms,
                  "embedding_model": embedding_status, "nli_model": nli_status,
                  "nli_probe_ms": nli_probe_ms}), flush=True)

for line in sys.stdin:
    item = {}
    try:
        item = json.loads(line)
        if item["type"] == "transcribe":
            if model is None:
                raise RuntimeError("ASR was skipped because the eval transcript cache is in use")
            audio = np.frombuffer(base64.b64decode(item["pcm"]), dtype="<i2").astype(np.float32) / 32768.0
            started = time.perf_counter()
            segments, _ = model.transcribe(audio, language="en", beam_size=3, vad_filter=True, word_timestamps=True)
            decoded = list(segments)
            rows = [{"start": item["start"] + segment.start, "end": item["start"] + segment.end,
                     "text": segment.text.strip(), "confidence": max(0.0, min(1.0, float(np.exp(segment.avg_logprob)) * (1.0 - segment.no_speech_prob))),
                     "words": [{"text": word.word.strip(), "start": item["start"] + word.start, "end": item["start"] + word.end} for word in (segment.words or [])]}
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
        elif item["type"] == "verify":
            if verifier is None or tokenizer is None or label_indices is None:
                raise RuntimeError(f"Local NLI verifier unavailable: {nli_status}")
            started = time.perf_counter()
            outputs = []
            input_names = {entry.name for entry in verifier.get_inputs()}
            for pair in item["pairs"]:
                encoded = tokenizer.encode(pair["premise"], pair["hypothesis"], add_special_tokens=True)
                feeds = {
                    "input_ids": np.asarray([encoded.ids], dtype=np.int64),
                    "attention_mask": np.asarray([encoded.attention_mask], dtype=np.int64),
                    "token_type_ids": np.asarray([encoded.type_ids], dtype=np.int64),
                }
                logits = verifier.run(None, {name: feeds[name] for name in input_names if name in feeds})[0][0]
                exp = np.exp(logits - np.max(logits))
                probs = exp / exp.sum()
                outputs.append({"contradiction": float(probs[label_indices["contradiction"]]),
                                "entailment": float(probs[label_indices["entailment"]]),
                                "neutral": float(probs[label_indices["neutral"]])})
            elapsed_ms = (time.perf_counter() - started) * 1000.0
            print(json.dumps({"type": "verified", "request_id": item["request_id"],
                              "pairs": outputs, "elapsed_ms": elapsed_ms,
                              "mean_pair_ms": elapsed_ms / max(1, len(outputs)),
                              "pair_count": len(outputs)}), flush=True)
    except Exception as exc:
        print(json.dumps({"type": "error", "message": str(exc), "request_id": item.get("request_id"),
                          "chunk_id": item.get("chunk_id"), "start": item.get("start")}), flush=True)
