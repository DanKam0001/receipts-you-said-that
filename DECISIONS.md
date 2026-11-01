# Decisions

- One local Node/TypeScript service hosts the control page, OBS overlay, WebSocket feed, clip endpoint, and chat input. A Python sidecar owns local faster-whisper and FastEmbed inference.
- OAuth uses Twitch Device Code Grant so approval works from a phone. The token file is `.tokens/twitch.json`; refresh always persists Twitch's rotated refresh token.
- File replay emits normalized mono 16 kHz PCM in eight-second real-time chunks. A matching WAV can be read directly; FFmpeg handles MP3, non-normalized WAV, and DirectShow device capture.
- Both audio sources feed the same bounded in-memory buffer and transcription queue. Clip audio is cut only from that buffer.
- Faster-whisper uses `small.en`, attempts CUDA FP16 then CPU int8 fallback, and stores model files under `D:/hf_cache`. FastEmbed uses the CPU `sentence-transformers/all-MiniLM-L6-v2` model in the same cache. Missing embeddings return CAN'T TELL.
- The matcher combines cosine sentence similarity and fuzzy lexical similarity; explicit polarity conflicts block a found receipt. Every outcome carries the combined score. Threshold evaluation tunes only the 15-claim tuning set and reports the held-out half separately.
- The streamer starts opted out. A local broadcaster control toggles opt-in; moderators/broadcaster may veto during the configurable hold. Chat lives are local demo stakes and do not use Affiliate features.
- Replay and demo assets stay under ignored `data/`; only `data/SOURCES.md` is retained in git.
