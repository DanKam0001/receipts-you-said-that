# Receipts: You Said That

## Product and build constraints

- Build the Codex x TwitchCon hackathon project for the Nov 2, 2026 2pm PT deadline.
- Runs locally on one Windows 11 PC. Server and OBS overlay use Node.js and TypeScript. A Python sidecar may provide local faster-whisper speech recognition.
- A viewer submits exactly one input form: `!receipts <plain-language claim>`. Do not add alternate query paths.
- Produce exactly three outcomes: RECEIPT FOUND (confident match; real audio, verbatim transcript quote, timestamp, and two surrounding sentences), NO MATCH (confident miss; chat loses a life), and CAN'T TELL (uncertain; no punishment).
- All displayed quotes must be sourced verbatim from this session's transcript, and played audio must come from the local rolling audio buffer. Never synthesize or paraphrase a quote.
- The streamer opts in. A moderator or broadcaster may veto each receipt through the local page or `!veto`, with a short configurable hold before playback.
- Audio input has interchangeable live capture-device and real-time file-replay implementations. Both feed the same rolling buffer/transcription path; replay must make an unattended demo possible.
- Speech recognition uses local faster-whisper. Support the GTX 1660 with 6GB VRAM and CPU fallback; no paid API is needed.
- Twitch uses OAuth user token, EventSub WebSocket `channel.chat.message`, and Send Chat Message API. Request `user:read:chat`, `user:write:chat`, and `user:bot`. Do not use Affiliate-only APIs.
- Credentials are in `.env`: `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_CHANNEL`. Never print, log, commit, or expose values. Commit `.env.example`. OAuth redirect is `http://localhost:3000`. `npm run auth` prints a human-approval URL, stores tokens only in a gitignored file, and handles refresh.
- OBS browser source is 1920x1080 with transparent background. Design for a readable, oversized game-show stamp on phone-sized streams; support visible audio and sound-off reading. Show chat lives.
- `npm run demo` runs without Twitch credentials using simulated chat and file replay. It must label simulated chat as `SIMULATED CHAT`; real Twitch chat must never show that label.
- Keep `.env`, tokens, audio data, and `CODEX_LOG` out of git. Commit implementation in small steps with plain messages.
- Make reasonable decisions without blocking on questions and record them in `DECISIONS.md`.

## Development rules

- Inspect local state and existing ignore rules before changing files.
- Use primary documentation for current Twitch and faster-whisper interfaces.
- Add focused tests for the decision/matcher and integration boundaries. Do not claim a live OAuth/EventSub test without human approval and credentials.
- Keep secrets and recorded audio local; use only synthetic/generated test fixtures for automated tests.
