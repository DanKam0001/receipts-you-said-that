# Evaluation results

Run date: 2026-11-01T08:52:45.618Z

## Status: BLOCKED

The existing `.venv` does not contain FastEmbed. The required package is already listed in `asr/requirements.txt`; per workspace instructions this runner does not install packages. Install that requirements file, then rerun. This blocks semantic embeddings and therefore the real claim evaluation.

The 30 labelled claims are in [claims.json](claims.json), split into 15 threshold-tuning claims and 15 held-out claims. No matcher score was used while authoring them. Because the real transcript and embeddings were not produced, no threshold sweep was run and no outcome, WER, accuracy, wrong-FOUND, or latency number is reported.

Replay fixture preparation did succeed: data/replay.wav exists (16 kHz mono real LibriVox speech with deterministic noise). The separate local E2E attempt also encountered Node spawn EPERM when starting Python, and a direct faster-whisper startup could not write its temporary model download under D:/hf_cache/faster-whisper. The full run command is npm run eval.
