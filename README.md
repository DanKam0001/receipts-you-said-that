# Receipts: You Said That

When a viewer types `!receipts <plain-language claim>`, Receipts searches the current local session transcript. A confident match shows the streamer's verbatim sentence, transcript timestamp, adjacent transcript context, and a clip cut from the in-memory audio buffer. A confident miss costs chat one life. An uncertain result never costs a life. There is no generated quote path.

## Requirements

- Windows 11, Node.js 20+, Python 3.10+, and FFmpeg on `PATH`.
- For local transcription and sentence matching: install `asr/requirements.txt` into `.venv`. Whisper and FastEmbed model files cache under `D:/hf_cache`.
- GPU mode uses faster-whisper CUDA FP16 and runs a real silence decode probe before reporting ready; any probe failure falls back to CPU int8. Set `RECEIPTS_ASR_DEVICE=cpu` to force CPU or `cuda` to try CUDA first. Optionally set `RECEIPTS_CUDA_DLL_DIR` to the folder containing CUDA DLLs (for example `D:/cuda12/nvidia/cublas/bin`); it is added to the DLL search path before faster-whisper loads. If a native CUDA DLL failure kills the sidecar before startup completes, Node retries with CPU int8. The control page and overlay expose sidecar health, queued audio, lag, and transcription real-time factor. The worker restarts with capped backoff and preserves queued chunks.
- A real speech recording (WAV or MP3) for replay demos. The app does not ship a canned transcript or synthesized speech.
- Current API references: [Twitch EventSub WebSocket](https://dev.twitch.tv/docs/eventsub/handling-websocket-events/), [Twitch Send Chat Message](https://dev.twitch.tv/docs/api/reference), and [faster-whisper README](https://github.com/SYSTRAN/faster-whisper/blob/master/README.md).

## Install and run

```powershell
npm install
if (!(Test-Path .env)) { Copy-Item .env.example .env }
python -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -r asr/requirements.txt
# Add your own local audio path to RECEIPTS_AUDIO in .env, e.g. C:\\Media\\stream-test.wav
npm run demo
```

Open `http://localhost:3000/control`, click opt-in, and start the replay if it did not auto-start. Submit `!receipts <claim>` in the simulated chat field. The OBS browser source URL is `http://localhost:3000/overlay.html`; set it to 1920x1080. Demo mode visibly displays `SIMULATED CHAT`. The control page can also start a DirectShow capture device by its FFmpeg device name.

`npm run demo` does not require Twitch credentials. `RECEIPTS_AUDIO` may be an absolute path; the audio source is played at real time. `RECEIPTS_PORT` can change the local server port if 3000 is already occupied. `npm run start` selects Twitch chat if credentials and a locally authorized token are present, otherwise it uses the simulator. Real chat never receives the simulated label.

## Twitch setup

Put the Twitch application values in `.env` without sharing the file. Device Code Grant does not use a localhost callback:

```dotenv
TWITCH_CLIENT_ID=your-client-id
TWITCH_CLIENT_SECRET=your-client-secret
TWITCH_CHANNEL=your-channel-login
```

Run `npm run auth`. Open the printed Twitch verification URL on a phone, enter the displayed code, and approve `user:read:chat`, `user:write:chat`, `user:bot`, and `channel:read:stream_key`. The URL/code are also written to ignored `data/auth_prompt.txt`; rotating access and refresh tokens are stored in `.tokens/twitch.json`. Run `npm run twitch:check` to validate identity/scopes and EventSub subscription. Append `-- --send "text"` only when intentionally sending a test chat message. Start the server with `npm run start`.

## Controls and current spike limits

- Broadcaster opt-in is off at startup and is toggled from `/control`.
- The hold defaults to five seconds (`RECEIPTS_HOLD_MS`). A moderator/broadcaster `!veto` or the local veto button cancels playback during the hold.
- `RECEIPTS_LIVES` sets the starting chat lives.
- Audio remains in a bounded in-memory ring buffer; it is not saved by this app. The transcription window is eight seconds and transcript timestamps are relative to the current replay/capture session.
- The matcher combines fuzzy lexical similarity and local sentence embeddings, with explicit polarity checks. It reports a score for every outcome. Thresholds remain uncalibrated until `npm run eval` completes on the local machine.
- This is an end-to-end spike. It does not yet implement durable transcript export, multiple simultaneous receipts, reconnect backoff policy, or a polished responsive streamer settings experience.

## Commands

```powershell
npm run demo       # local simulator + optional file replay
npm run auth       # Device Code Grant; approve on any device
npm run start      # local server, Twitch chat if token exists
npm test           # matcher and rolling buffer tests
npm run typecheck  # TypeScript check
npm run eval       # real-time replay + faster-whisper evaluation and threshold sweep
npm run eval -- --fast  # eval-only accelerated replay; transcript cached for later sweeps
npm run build      # compile to dist/
```
