# Decisions

- One local Node/TypeScript service hosts the control page, OBS overlay, WebSocket feed, clip endpoint, and chat input. A Python sidecar owns local faster-whisper and FastEmbed inference.
- OAuth uses Twitch Device Code Grant so approval works from a phone. The token file is `.tokens/twitch.json`; refresh always persists Twitch's rotated refresh token.
- File replay emits normalized mono 16 kHz PCM in eight-second real-time chunks. A matching WAV can be read directly; FFmpeg handles MP3, non-normalized WAV, and DirectShow device capture.
- Both audio sources feed the same bounded in-memory buffer and transcription queue. Clip audio is cut only from that buffer.
- Faster-whisper uses `small.en`, attempts CUDA FP16 then runs an actual consumed silence transcription probe before reporting ready; any CUDA probe error falls back to CPU int8. `RECEIPTS_ASR_DEVICE=cpu|cuda` controls the requested device. Model files stay under `D:/hf_cache`. FastEmbed uses the CPU `sentence-transformers/all-MiniLM-L6-v2` model in the same cache. Missing embeddings return CAN'T TELL.
- The speech sidecar has capped exponential restart backoff. It preserves the in-flight audio chunk and all queued chunks across process/pipe failure, reports queue audio seconds and per-chunk real-time factor, and exposes health to the local control page and OBS overlay. No chunks are discarded to mask ASR lag.
- `npm run eval` defaults to real-time replay. `npm run eval -- --fast` accelerates only the eval replay clock while retaining the same PCM chunk/transcription path. A validated ignored transcript cache avoids repeat ASR work during threshold iterations; held-out output includes each expected/actual label and score.
- The matcher combines cosine sentence similarity and fuzzy lexical similarity; explicit polarity conflicts block a found receipt. Every outcome carries the combined score. Threshold evaluation tunes only the 15-claim tuning set and reports the held-out half separately.
- The streamer starts opted out. A local broadcaster control toggles opt-in; moderators/broadcaster may veto during the configurable hold. Chat lives are local demo stakes and do not use Affiliate features.
- Replay and demo assets stay under ignored `data/`; only `data/SOURCES.md` is retained in git.
