# End-to-end replay proof

Exact PowerShell run: `$env:RECEIPTS_PORT="3103"; $env:RECEIPTS_AUDIO="data/replay.wav"; $env:RECEIPTS_GPU="cpu"; npm run demo`. Source file: real LibriVox Chapter 1 mixed with generated noise, `data/replay.wav`.

Observed: the normalized WAV replay started; API snapshots showed 16 seconds and then 32 seconds in the rolling buffer; `/overlay.html` and `/control` returned HTTP 200; the overlay WebSocket delivered `simulated: true`, `audio: "running"`, and the live buffer duration. After opt-in, `!receipts Alice was bored sitting beside her sister` reached the shared chat path and displayed CAN'T TELL. Chat lives stayed at 3.

The captured snapshots are in [e2e-proof.json](e2e-proof.json). The run did not produce transcript text, a FOUND receipt, or a clip. `WhisperWorker` failed to launch its Python child with Windows `spawn EPERM` in this environment, so the matcher correctly failed closed to CAN'T TELL. The current `.venv` also lacks FastEmbed, preventing `npm run eval` from proceeding. Thus this run proves real file replay -> rolling buffer -> simulated chat/WebSocket overlay state, but it does not prove replay -> faster-whisper -> embedding match -> clip playback.
