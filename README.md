# Receipts: You Said That

Receipts lets a viewer type `!receipts <claim>` and checks the claim against the streamer's local session transcript. A confident match plays the streamer's actual buffered voice with an exact transcript quote; uncertain evidence never costs chat a life.

## Try it in one command

Install Node.js 20+, Python 3, and FFmpeg, then clone and run:

```sh
npm install
npm run demo
```

The demo creates `.venv` and installs the local speech packages on first run, then starts the bundled 75-second public-domain audiobook excerpt, opts in, and opens the scripted local demo at [http://localhost:3000/demo](http://localhost:3000/demo). Model files download on first run when online. The page offers three preset claims and free text. The source is clearly labelled **SCRIPTED AUDIO** and **SIMULATED CHAT**; it does not represent a real streamer or viewers. The OBS overlay is [http://localhost:3000/overlay.html](http://localhost:3000/overlay.html).

## How it works

```text
Live capture device ─┐
                     ├─> rolling local audio buffer ─> faster-whisper ─> timestamped transcript
Real-time file replay┘                                                     │
                                                                           v
Twitch !receipts claim ─> hybrid retrieval ─> local NLI verify ─> exact quote + buffered clip
                                                                           │
                                                            veto hold ─> OBS overlay + chat reply
```

Both audio sources share the same path. Replay runs in real time by default, so the demo exercises the same chunking, transcription, matching, veto, and clip path as capture. Audio stays on the machine; only the result reply is sent to Twitch chat.

## The three outcomes

- **RECEIPT FOUND**: a candidate passes entailment and contradiction checks. The quote is verbatim transcript text, refined to the shortest adjacent sentence span that still verifies; playback comes from the local audio buffer.
- **NO MATCH**: no transcript candidate was retrieved, or an on-topic candidate clearly contradicts the claim. Only this confident miss costs chat a life.
- **CAN'T TELL**: transcription or matching evidence is weak, conflicting, or off-topic. Nobody is punished for uncertainty or a transcription error.

Each result shows its entailment score and deciding candidate. The streamer opts in, and moderators or the broadcaster have a short veto window before a found clip plays.

## Privacy

Audio is held in a bounded, local rolling buffer (three minutes by default). Confirmed receipt clips and their JSON records persist locally under ignored `data/receipts/`; no audio or transcript is uploaded. The app sends a chat reply through Twitch when connected. Opt-in starts off for real Twitch mode; the scripted demo opts in automatically and identifies itself as simulated.

## Honest results

The headline speech evaluation used the cached transcript from the 75-second LibriVox *Alice's Adventures in Wonderland* audiobook excerpt with synthetic background noise, not a real streamer. The claims were written by Codex. On the fresh audio set, **15/20 outcomes were correct**, with **zero wrong RECEIPT FOUND** and **6 of 10 true claims found**. Mean claim-to-decision latency was **207.8 ms**, p95 **242.5 ms**; GPU ASR mean real-time factor was **0.203**, and WER was **11.53%**. The separate synthetic first-person gaming text set scored **15/16**, including **one wrong RECEIPT FOUND**. These results are reproduced from [eval/RESULTS.md](eval/RESULTS.md); the synthetic-text result is not speech accuracy evidence.

The current TypeScript suite passed **14 checks** in the latest `npm test` run (8 matcher/audio assertions plus 6 replay, sidecar, storage, and receipt-refinement checks).

## How Codex built it

Built in one Codex thread, including the TypeScript server, replay and capture path, Python sidecar, matcher, overlay, Twitch integration, demo, and evaluation harness. The first single-score matcher scored 3/30, so it was replaced with retrieval plus NLI verification. Development also fixed an eval completion hang, narrowed a blunt negation guard, and changed NO MATCH so weak evidence cannot unfairly cost a life.

## Real Twitch setup

Copy `.env.example` to `.env` and fill in the Twitch application client ID, client secret, and channel login. Run `npm run auth`; open the printed verification URL on a phone and approve the Device Code Grant. The one-time URL and code are written to ignored `data/auth_prompt.txt`, and the access/refresh token is stored in ignored `.tokens/`. Run `npm run twitch:check` to validate scopes and EventSub. It sends a test message only when explicitly invoked with `-- --send "text"`. Then run `npm start`; real chat does not show the simulated label. Never share `.env` or `.tokens/`.

For an OBS browser source, use `http://localhost:3000/overlay.html` at 1920x1080 with a transparent background. `/control` has opt-in, replay/capture, and veto controls; `/receipts` lists saved clips; `/proof` identifies simulated versus connected Twitch mode without exposing secrets.

## Limits

This is a local hackathon prototype. Speech recognition and NLI depend on audio quality and local compute; the measured WER and misses show those limits. The audiobook and Codex-written claims are a reproducible fixture, not representative streamer speech. The synthetic first-person test contains one false receipt, so the current thresholds do not establish production-safe accuracy. Windows 11 is the primary target; setup and virtual-environment paths support POSIX too. CUDA is optional; CPU int8 works, though first-run model downloads need internet unless the Hugging Face cache is already populated.
