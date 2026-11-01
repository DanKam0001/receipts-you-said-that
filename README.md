# Receipts: You Said That

When a viewer types `!receipts <plain-language claim>`, Receipts searches the current local session transcript. A confident match shows the streamer's verbatim sentence, transcript timestamp, adjacent transcript context, and a clip cut from the in-memory audio buffer. A confident miss costs chat one life. An uncertain result never costs a life. There is no generated quote path.

## Requirements

- Windows 11, Node.js 20+, Python 3.10+, and FFmpeg on `PATH`.
- For local transcription: `python -m pip install -r asr/requirements.txt`. The first start downloads the selected model to the normal local Hugging Face cache.
- GPU mode uses faster-whisper CUDA FP16; CPU fallback uses int8. Current faster-whisper requires CUDA 12 + cuDNN 9 for current CTranslate2 releases. Windows users need NVIDIA runtime libraries on `PATH`; otherwise set `RECEIPTS_GPU=cpu`.
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

Create a Twitch developer application with redirect URL `http://localhost:3000`, then put these values in `.env` without sharing the file:

```dotenv
TWITCH_CLIENT_ID=your-client-id
TWITCH_CLIENT_SECRET=your-client-secret
TWITCH_CHANNEL=your-channel-login
```

Run `npm run auth`. Open the printed approval URL and approve `user:read:chat`, `user:write:chat`, and `user:bot`. The callback stores access and refresh tokens in `.tokens/twitch.json`; this path is gitignored. Start the server with `npm run start`. EventSub WebSocket connects and subscribes to `channel.chat.message` after `session_welcome`; chat sends use the Helix Send Chat Message API.

## Controls and current spike limits

- Broadcaster opt-in is off at startup and is toggled from `/control`.
- The hold defaults to five seconds (`RECEIPTS_HOLD_MS`). A moderator/broadcaster `!veto` or the local veto button cancels playback during the hold.
- `RECEIPTS_LIVES` sets the starting chat lives.
- Audio remains in a bounded in-memory ring buffer; it is not saved by this app. The transcription window is eight seconds and transcript timestamps are relative to the current replay/capture session.
- Matcher thresholds are conservative lexical overlap heuristics, not a semantic model. Tune on real stream audio before relying on life loss; no confidence calibration has been done.
- This is an end-to-end spike. It does not yet implement durable transcript export, multiple simultaneous receipts, reconnect backoff policy, or a polished responsive streamer settings experience.

## Commands

```powershell
npm run demo       # local simulator + optional file replay
npm run auth       # print Twitch OAuth URL and receive approval callback
npm run start      # local server, Twitch chat if token exists
npm test           # matcher and rolling buffer tests
npm run typecheck  # TypeScript check
npm run build      # compile to dist/
```
