import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { WebSocketServer } from "ws";
import { FfmpegPcmSource, resetReplaySession, RollingAudioBuffer } from "./audio.js";
import { decideVerified, DEFAULT_THRESHOLDS, normalizeClaimForNli, retrieve, type DecisionThresholds } from "./matcher.js";
import type { ChatMessage, Receipt, Utterance } from "./model.js";
import { SimulatedChatSource, TwitchChatSource, type ChatSource } from "./twitch.js";
import { WhisperWorker } from "./transcriber.js";
import { ReceiptStore } from "./receipt-store.js";
import { refineFoundReceipt } from "./receipt-refinement.js";
import { ANNOUNCER_FILES, announcerForOutcome, maySettle, replayCooldownRemaining, selectReplayReceipt, type AnnouncerFile } from "./show-control.js";

const app = express(); app.use(express.json()); app.use(express.static("public"));
const http = createServer(app), wss = new WebSocketServer({ server: http });
const demo = process.argv.includes("--demo");
let decisionThresholds: DecisionThresholds = DEFAULT_THRESHOLDS;
try { decisionThresholds = { ...DEFAULT_THRESHOLDS, ...JSON.parse(readFileSync("data/nli-thresholds.json", "utf8")) }; } catch { /* Use defaults until eval writes tune-only thresholds. */ }
const maxLives = Number(process.env.RECEIPTS_LIVES ?? 3);
let lives = maxLives, optedIn = demo;
let receipt: Receipt | undefined, audioSource: FfmpegPcmSource | undefined, chat: ChatSource;
let eventsubConnected = false, lifetimeReceiptCount = 0;
const buffer = new RollingAudioBuffer(180), transcript: Utterance[] = [], clips = new Map<string, Buffer>();
let onRecordReceipt: Receipt | undefined;
let playedReceipts: Receipt[] = [];
let lastReplayStartedAt: number | undefined;
let activeReplayReceiptId: string | undefined;
let announcerEvent: { id: string; file: AnnouncerFile } | undefined;
let overlayPlayback: { requestId: string; kind: "receipt" | "replay"; playing: boolean; receipt: Receipt; clipUrl: string } | undefined;
let stopPlaybackRequest: string | undefined;
const clients = new Set<import("ws").WebSocket>();

const receiptStore = new ReceiptStore(resolve(process.env.RECEIPTS_DATA_DIR || "data/receipts"));
function snapshot() { return { lives, maxLives, optedIn, receipt, onRecordReceipt, announcerFiles: ANNOUNCER_FILES, announcerEnabled: process.env.RECEIPTS_ANNOUNCER !== "0", announcerEvent, overlayPlayback, stopPlaybackRequest, transcript: transcript.length, embeddingMs: lastEmbeddingLatency, bufferedSeconds: buffer.bufferedSeconds, asr: worker.status, audio: audioSource ? "running" : "stopped", source: chat ? (chat.simulated ? "simulated" : "twitch") : "none", simulated: Boolean(chat?.simulated), scriptedAudio: demo || process.env.RECEIPTS_SCRIPTED_AUDIO === "1", eventsubConnected, lifetimeReceiptCount, holdMs: Number(process.env.RECEIPTS_HOLD_MS ?? 5000) }; }
function broadcast() { const value = JSON.stringify(snapshot()); for (const c of clients) if (c.readyState === 1) c.send(value); }
wss.on("connection", c => { clients.add(c); c.send(JSON.stringify(snapshot())); c.on("close", () => clients.delete(c)); });

const worker = new WhisperWorker();
worker.on("ready", device => console.log(`Local faster-whisper ready (${device})`));
worker.on("status", () => broadcast());
worker.on("log", line => console.log(`[ASR] ${line}`));
worker.on("embeddingLatency", ms => { lastEmbeddingLatency = ms; broadcast(); });
worker.on("error", err => console.error(`[ASR] ${err.message}`));
worker.on("transcript", (segments: Utterance[]) => {
  for (const s of segments) if (s.text && !transcript.some(t => Math.abs(t.start - s.start) < 0.5 && t.text === s.text)) transcript.push(s);
  transcript.sort((a, b) => a.start - b.start);
  broadcast();
});

function sendReply(text: string) { void chat?.send(text).catch(e => console.error(`Chat send failed (${(e as Error).message})`)); }
function announce(file: AnnouncerFile) { announcerEvent = { id: randomUUID(), file }; }
async function startAudio(mode: "file" | "device", value: string) {
  await audioSource?.stop();
  if (mode === "file") resetReplaySession(buffer, transcript);
  const source = new FfmpegPcmSource(value, mode); audioSource = source;
  source.on("chunk", (chunk: { start: number; end: number; pcm: Buffer }) => { buffer.push(chunk); worker.submit(chunk); broadcast(); });
  source.on("error", (err: Error) => console.error(`[audio] ${err.message}`));
  source.on("end", code => { console.log(`Audio source ended (${code})`); broadcast(); });
  try { await source.start(); }
  catch (error) { if (audioSource === source) audioSource = undefined; throw error; }
  try { worker.start(); } catch (e) { console.error(`[ASR] unable to start local speech worker (${(e as Error).message})`); }
  broadcast();
}

let lastEmbeddingLatency = 0;
async function archiveReceipt(receiptToSave: Receipt, wavClip: Buffer) {
  lifetimeReceiptCount = await receiptStore.save({ id: receiptToSave.id, quote: receiptToSave.quote, timestamp: receiptToSave.timestamp,
    quoteEnd: receiptToSave.quoteEnd, clipStart: receiptToSave.clipStart, clipEnd: receiptToSave.clipEnd, requester: receiptToSave.requester,
    outcome: "RECEIPT FOUND", score: receiptToSave.score, candidateId: receiptToSave.candidateId,
    retrievalScore: receiptToSave.retrievalScore }, wavClip);
  broadcast();
}
void receiptStore.list().then(rows => { lifetimeReceiptCount = rows.length; broadcast(); });
function canVeto(message: ChatMessage) { return message.isMod || message.isBroadcaster; }
function processChat(message: ChatMessage) {
  const text = message.text.trim();
  if (/^!veto(?:\s|$)/i.test(text)) {
    if (!canVeto(message)) { sendReply("Only moderators and the broadcaster can veto."); return; }
    if (activeReplayReceiptId && overlayPlayback?.kind === "replay" && overlayPlayback.playing) {
      const replayId = activeReplayReceiptId, requestId = overlayPlayback.requestId;
      activeReplayReceiptId = undefined;
      clips.delete(replayId);
      playedReceipts = playedReceipts.filter(item => item.id !== replayId);
      if (receipt?.id === replayId) receipt.status = "vetoed";
      overlayPlayback.receipt.status = "vetoed";
      if (onRecordReceipt?.id === replayId) onRecordReceipt = undefined;
      overlayPlayback = { ...overlayPlayback, playing: false };
      stopPlaybackRequest = requestId;
      announce("vetoed.mp3");
      sendReply("Replay vetoed and removed from the hall of shame.");
      void receiptStore.remove(replayId).then(count => { lifetimeReceiptCount = count; broadcast(); })
        .catch(error => console.error(`[receipts] Could not remove vetoed replay: ${(error as Error).message}`));
      broadcast();
    } else if (receipt?.outcome === "RECEIPT FOUND" && receipt.status === "pending") {
      receipt.status = "vetoed"; clips.delete(receipt.id); clearTimeout(pendingTimer); announce("vetoed.mp3"); sendReply("Receipt vetoed. No clip will play."); broadcast();
    } else sendReply("There is no pending receipt or replay to veto.");
    return;
  }
  if (/^!settled(?:\s|$)/i.test(text)) {
    if (!maySettle(message.isMod, message.isBroadcaster)) { sendReply("Only moderators and the broadcaster can clear the on-record quote."); return; }
    if (!onRecordReceipt) { sendReply("There is no on-record quote to clear."); return; }
    onRecordReceipt = undefined; sendReply("Settled. The on-record quote is cleared."); broadcast(); return;
  }
  const replayMatch = text.match(/^!replay(?:\s+(\d+))?$/i);
  if (replayMatch) {
    if (!optedIn) { sendReply("Receipts are opted out by the broadcaster."); return; }
    const cooldown = replayCooldownRemaining(lastReplayStartedAt, Date.now(), Number(process.env.RECEIPTS_REPLAY_COOLDOWN_S ?? 60));
    if (cooldown > 0) { sendReply(`Replay is on cooldown for ${cooldown}s.`); return; }
    const ordinal = replayMatch[1] ? Number(replayMatch[1]) : undefined;
    const selected = selectReplayReceipt(playedReceipts, ordinal);
    if (!selected) { sendReply(playedReceipts.some(item => item.status === "played") ? "There is no played receipt at that number." : "There is nothing to replay yet."); return; }
    void beginReplay(selected);
    return;
  }
  const match = text.match(/^!receipts\s+(.{4,240})$/i);
  if (!match) return;
  if (!optedIn) { sendReply("Receipts are opted out by the broadcaster."); return; }
  clearTimeout(pendingTimer);
  if (receipt) clips.delete(receipt.id);
  stopPlaybackRequest = undefined;
  const query = match[1], start = performance.now();
  void decideClaim(query, message.username, start);
}

async function beginReplay(selected: Receipt) {
  if (!optedIn || selected.status !== "played") return;
  const clip = clips.get(selected.id) ?? await receiptStore.clip(selected.id);
  if (!clip) { sendReply("That receipt's clip is no longer available to replay."); return; }
  lastReplayStartedAt = Date.now();
  activeReplayReceiptId = selected.id;
  stopPlaybackRequest = undefined;
  const replayReceipt = { ...selected, quoteWords: selected.quoteWords ? [...selected.quoteWords] : undefined };
  overlayPlayback = { requestId: randomUUID(), kind: "replay", playing: true, receipt: replayReceipt, clipUrl: `/api/clip/${encodeURIComponent(selected.id)}` };
  sendReply(`Playing receipt ${selected.id} from the hall of shame.`);
  broadcast();
}

async function decideClaim(query: string, username: string, startedAt: number) {
  let candidates;
  let probabilities;
  try {
    const proposition = normalizeClaimForNli(query);
    const queryEmbedding = await worker.embed(proposition);
    candidates = retrieve(query, transcript, queryEmbedding, 8);
    probabilities = await worker.verify(candidates.map(candidate => ({ premise: candidate.premise, hypothesis: proposition })));
  }
  catch (error) {
    receipt = { id: randomUUID(), outcome: "CAN'T TELL", query, requester: username, status: "pending", score: 0,
      reason: `Local retrieval/verification unavailable: ${(error as Error).message}` };
    sendReply("CAN'T TELL. Local retrieval or verification model is not ready; no life lost."); broadcast(); return;
  }
  receipt = decideVerified(query, candidates, probabilities, username, randomUUID(), decisionThresholds);
  if (receipt.outcome === "RECEIPT FOUND") {
    const winner = candidates.find(candidate => candidate.id === receipt!.candidateId);
    if (winner) try { receipt = await refineFoundReceipt(receipt, winner, transcript, pairs => worker.verify(pairs), decisionThresholds, Number(process.env.RECEIPTS_MAX_CLIP_S ?? 15)); }
    catch (error) { console.error(`[receipts] Quote refinement unavailable; retained verified window: ${(error as Error).message}`); }
  }
  receipt.decisionMs = Number((performance.now() - startedAt).toFixed(1));
  console.log(`Receipt decision completed (${receipt.outcome}, entailment=${receipt.score.toFixed(3)}, candidate=${receipt.candidateId ?? "none"}, retrieval=${receipt.retrievalScore?.toFixed(3) ?? "none"}, decision_ms=${receipt.decisionMs})`);
  if (receipt.outcome === "NO MATCH") { lives = Math.max(0, lives - 1); sendReply(`NO MATCH. Chat loses a life. ${lives} remain.`); announce(announcerForOutcome(receipt.outcome)); }
  else if (receipt.outcome === "CAN'T TELL") { sendReply("CAN'T TELL. No life lost."); announce(announcerForOutcome(receipt.outcome)); }
  else {
    const foundReceipt = receipt;
    const wavClip = buffer.clip(foundReceipt.clipStart!, foundReceipt.clipEnd!);
    if (!wavClip) { foundReceipt.outcome = "CAN'T TELL"; foundReceipt.reason = "The matching audio is no longer in the rolling buffer"; sendReply("CAN'T TELL. Audio is no longer available; no life lost."); announce(announcerForOutcome(foundReceipt.outcome)); }
    else {
      clips.set(foundReceipt.id, wavClip);
    }
    if (foundReceipt.outcome === "RECEIPT FOUND") {
      announce(announcerForOutcome(foundReceipt.outcome));
      sendReply("RECEIPT FOUND. Mod veto window is open.");
      const currentId = foundReceipt.id;
      const holdMs = Math.max(0, Number(process.env.RECEIPTS_HOLD_MS ?? 5000));
      foundReceipt.vetoUntil = Date.now() + holdMs;
      pendingTimer = setTimeout(() => {
        if (receipt?.id !== currentId || receipt.status !== "pending") return;
        receipt.status = "played"; receipt.vetoUntil = undefined;
        onRecordReceipt = receipt;
        playedReceipts.push(receipt);
        overlayPlayback = { requestId: randomUUID(), kind: "receipt", playing: true, receipt, clipUrl: `/api/clip/${encodeURIComponent(currentId)}` };
        void archiveReceipt(receipt, wavClip!).catch(error => console.error(`[receipts] Could not persist receipt ${currentId}: ${(error as Error).message}`)).finally(broadcast);
        broadcast();
        setTimeout(() => clips.delete(currentId), 60_000).unref();
      }, holdMs);
    }
  }
  broadcast();
}
let pendingTimer: ReturnType<typeof setTimeout>;

app.get("/", (_req, res) => res.redirect("/overlay.html"));
app.get("/control", (_req, res) => res.sendFile(resolve("public/control.html")));
app.get("/receipts", (_req, res) => res.sendFile(resolve("public/receipts.html")));
app.get("/proof", (_req, res) => res.sendFile(resolve("public/proof.html")));
app.get("/demo", (_req, res) => demo ? res.sendFile(resolve("public/demo.html")) : res.sendStatus(404));
app.get("/stage", (_req, res) => res.sendFile(resolve("public/stage.html")));
app.get("/overlay-layout.js", (_req, res) => res.type("application/javascript").sendFile(resolve("dist/src/overlay-layout.js")));
app.get("/show-control.js", (_req, res) => res.type("application/javascript").sendFile(resolve("dist/src/show-control.js")));
app.get("/api/state", (_req, res) => res.json(snapshot()));
app.get("/api/clip/:id", async (req, res) => { const clip = clips.get(req.params.id) ?? await receiptStore.clip(req.params.id); if (!clip) return res.sendStatus(404); res.type("audio/wav").send(clip); });
app.get("/api/receipts", async (_req, res) => res.json(await receiptStore.list()));
app.get("/api/receipts/:id/clip", async (req, res) => {
  const clip = await receiptStore.clip(req.params.id);
  if (!clip) return res.sendStatus(404);
  res.type("audio/wav").send(clip);
});
app.post("/api/opt-in", (_req, res) => { optedIn = !optedIn; if (!optedIn) onRecordReceipt = undefined; res.json(snapshot()); broadcast(); });
app.post("/api/simulate", (req, res) => {
  if (!demo || !(chat instanceof SimulatedChatSource)) return res.sendStatus(403);
  const text = String(req.body?.text ?? "").slice(0, 260);
  chat.inject({ userId: "demo-viewer", username: String(req.body?.username ?? "demo_viewer"), text, isMod: req.body?.isMod === true, isBroadcaster: req.body?.isBroadcaster === true });
  res.json({ accepted: true });
});
app.post("/api/veto", (_req, res) => {
  processChat({ userId: "local-control", username: "local_control", text: "!veto", isMod: true, isBroadcaster: false });
  res.json(snapshot());
});
app.post("/api/playback/complete", (req, res) => {
  const requestId = String(req.body?.requestId ?? "");
  if (overlayPlayback?.requestId === requestId) {
    if (overlayPlayback.kind === "replay" && activeReplayReceiptId === overlayPlayback.receipt.id) activeReplayReceiptId = undefined;
    if (overlayPlayback.kind === "receipt" && overlayPlayback.receipt.status === "played") onRecordReceipt = overlayPlayback.receipt;
    overlayPlayback = { ...overlayPlayback, playing: false };
  }
  if (stopPlaybackRequest === requestId) { stopPlaybackRequest = undefined; overlayPlayback = undefined; }
  broadcast(); res.json({ ok: true });
});
app.post("/api/replay", async (req, res) => {
  try { const path = String(req.body?.path ?? process.env.RECEIPTS_AUDIO ?? ""); if (!path) throw new Error("Choose a WAV or MP3 replay path"); await startAudio("file", path); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
app.post("/api/live", async (req, res) => {
  try { const device = String(req.body?.device ?? ""); if (!device) throw new Error("Enter an FFmpeg DirectShow audio device name"); await startAudio("device", device); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

if (demo) chat = new SimulatedChatSource();
else if (process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET && process.env.TWITCH_CHANNEL && existsSync(".tokens/twitch.json"))
  chat = new TwitchChatSource({ clientId: process.env.TWITCH_CLIENT_ID, clientSecret: process.env.TWITCH_CLIENT_SECRET, channel: process.env.TWITCH_CHANNEL });
else chat = new SimulatedChatSource();
chat.on("message", (message: ChatMessage) => processChat(message));
chat.on("ready", () => { eventsubConnected = !chat.simulated; console.log(chat.simulated ? "Simulated chat connected" : "Twitch EventSub chat connected"); broadcast(); });
chat.on("error", (err: Error) => { eventsubConnected = false; console.error(`[chat] ${err.message}`); broadcast(); });

const port = Number(process.env.RECEIPTS_PORT ?? (new URL(process.env.RECEIPTS_REDIRECT_URI ?? "http://localhost:3000").port || 3000));
http.listen(port, "127.0.0.1", async () => {
  console.log(`Receipts ${demo ? "demo" : "server"} listening at http://localhost:${port}`);
  console.log(`OBS overlay: http://localhost:${port}/overlay.html (1920x1080)`);
  console.log(`Local controls: http://localhost:${port}/control`);
  if (demo) console.log("SCRIPTED AUDIO and SIMULATED CHAT demo. Open /demo for one-click claims.");
  try { await chat.start(); }
  catch (e) { console.error(`Chat connection failed: ${(e as Error).message}`); }
  const replay = demo ? "demo/sample_public_domain.wav" : process.env.RECEIPTS_AUDIO;
  if (replay && existsSync(replay)) void startAudio("file", replay).catch(e => console.error(`[audio] ${(e as Error).message}`));
  else console.log("No replay started. Set RECEIPTS_AUDIO or choose a source in /control.");
});

process.on("SIGINT", () => { void audioSource?.stop(); worker.stop(); chat.stop(); http.close(); process.exit(0); });
