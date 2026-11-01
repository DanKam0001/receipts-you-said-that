import base64
import json
import os
import sys

import numpy as np
from faster_whisper import WhisperModel

size = os.environ.get("RECEIPTS_ASR_MODEL", "small.en")
requested = os.environ.get("RECEIPTS_GPU", "cuda")
try:
    if requested == "cpu":
        raise RuntimeError("CPU explicitly selected")
    model = WhisperModel(size, device="cuda", compute_type="float16")
    device = "cuda/float16"
except Exception as exc:
    print(json.dumps({"type": "status", "message": "Using CPU int8 fallback"}), flush=True)
    model = WhisperModel(size, device="cpu", compute_type="int8")
    device = "cpu/int8"

print(json.dumps({"type": "ready", "device": device}), flush=True)
for line in sys.stdin:
    try:
        item = json.loads(line)
        audio = np.frombuffer(base64.b64decode(item["pcm"]), dtype="<i2").astype(np.float32) / 32768.0
        segments, _ = model.transcribe(audio, language="en", beam_size=3, vad_filter=True)
        result = [{"start": item["start"] + s.start, "end": item["start"] + s.end,
                   "text": s.text.strip(), "confidence": max(0.0, min(1.0, float(np.exp(s.avg_logprob)) * (1.0 - s.no_speech_prob)))}
                  for s in segments if s.text.strip()]
        print(json.dumps({"type": "transcript", "segments": result}), flush=True)
    except Exception as exc:
        print(json.dumps({"type": "error", "message": str(exc)}), flush=True)
