# Decisions

- One npm package hosts the local HTTP API, WebSocket overlay feed, OAuth callback, local veto screen, and OBS overlay static assets to keep the spike easy to run on Windows.
- Audio is normalized to mono 16 kHz PCM by FFmpeg for both replay and DirectShow capture. The source adapter delivers identical timestamped PCM chunks to the rolling buffer and transcription queue.
- The rolling buffer is a bounded in-memory PCM ring. Clip data is served only from that ring, and no audio is persisted to disk by the server.
- The Python sidecar transcribes bounded chunks with faster-whisper `small.en`; GPU `cuda`/`float16` is attempted first, with CPU `int8` fallback. This suits English demo claims and a 6GB GPU; a larger model is an operator choice.
- Demo audio is an operator-supplied speech WAV/MP3 (`RECEIPTS_AUDIO`) so quotes are recognized from real recorded speech. No canned transcript, TTS, or synthetic receipt is shipped. A default silent test tone would be misleading, so the CLI explains how to select a replay file.
- Matching is lexical and conservative: exact words must appear in transcript segments; high overlap yields a candidate, ambiguous overlap yields CAN'T TELL, and a confident miss yields NO MATCH. These thresholds are intentionally visible/configurable and should be tuned on the streamer's speech.
- For local auth the OAuth redirect listens on `localhost:3000`. The initial installed chatbot user token is used for both chat reading and sending; EventSub subscription creation is a Helix call made immediately after `session_welcome`.
- The app starts opted out; broadcaster toggles opt-in from the local control page. Veto privilege uses EventSub `is_mod` plus broadcaster identity.
- Chat lives are demo stakes tracked by the local server, not Twitch punishment or an Affiliate feature.
