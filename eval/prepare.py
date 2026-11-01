import json
import math
import os
import subprocess
import urllib.request
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
DATA.mkdir(exist_ok=True)
AUDIO_URL = "https://www.archive.org/download/alice_in_wonderland_librivox/wonderland_ch_01_64kb.mp3"
TEXT_URL = "https://www.gutenberg.org/files/11/11-0.txt"
SOURCE_MP3 = DATA / "alice_chapter1_librivox.mp3"
REFERENCE = DATA / "alice_reference.txt"
NOISE_WAV = DATA / "game_noise.wav"
REPLAY_WAV = DATA / "replay.wav"
DURATION_SECONDS = 640.6
RATE = 16000
SEED = 20261101

def download(url: str, target: Path) -> None:
    if target.exists() and target.stat().st_size > 100_000:
        return
    request = urllib.request.Request(url, headers={"User-Agent": "ReceiptsHackathonEval/1.0 (public-domain speech benchmark)"})
    with urllib.request.urlopen(request, timeout=60) as response, target.open("wb") as output:
        while block := response.read(1024 * 256):
            output.write(block)

def make_game_noise() -> None:
    count = round(DURATION_SECONDS * RATE)
    rng = np.random.default_rng(SEED)
    samples = (rng.standard_normal(count).astype(np.float32) * 0.018)
    # Brief synthesized arcade-like chirps at sparse intervals under the spoken voice.
    for at in (37, 91, 149, 211, 277, 341, 409, 473, 541, 603):
        length = round(0.38 * RATE)
        t = np.arange(length, dtype=np.float32) / RATE
        freq = np.linspace(520, 980, length, dtype=np.float32)
        phase = 2 * np.pi * np.cumsum(freq) / RATE
        envelope = np.minimum(1, t / 0.02) * np.maximum(0, 1 - t / 0.38)
        start = at * RATE
        samples[start:start + length] += (np.sin(phase) * envelope * 0.055).astype(np.float32)
    samples = np.clip(samples, -0.25, 0.25)
    with wave.open(str(NOISE_WAV), "wb") as out:
        out.setnchannels(1); out.setsampwidth(2); out.setframerate(RATE)
        out.writeframes((samples * 32767).astype("<i2").tobytes())

def main() -> None:
    download(AUDIO_URL, SOURCE_MP3)
    download(TEXT_URL, REFERENCE)
    make_game_noise()
    subprocess.run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(SOURCE_MP3), "-i", str(NOISE_WAV),
        "-filter_complex", "[0:a]aresample=16000,volume=1.0[voice];[1:a]volume=1.0[bed];[voice][bed]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.98[mix]",
        "-map", "[mix]", "-ac", "1", "-ar", str(RATE), str(REPLAY_WAV)
    ], check=True)
    print(json.dumps({"audio": str(REPLAY_WAV), "duration_seconds": DURATION_SECONDS, "bytes": REPLAY_WAV.stat().st_size,
                      "noise_rms": 0.018, "noise_seed": SEED}))

if __name__ == "__main__":
    main()
