import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { WebSocketServer } from "ws";
import { FfmpegPcmSource, RollingAudioBuffer } from "./audio.js";
import { decideVerified, DEFAULT_THRESHOLDS, normalizeClaimForNli, retrieve, type DecisionThresholds } from "./matcher.js";
import type { ChatMessage, Receipt, Utterance } from "./model.js";
import { SimulatedChatSource, TwitchChatSource, type ChatSource } from "./twitch.js";
import { WhisperWorker } from "./transcriber.js";
import { ReceiptStore } from "./receipt-store.js";

const app = express(); app.use(express.json()); app.use(express.static("public"));
const http = createServer(app), wss = new WebSocketServer({ server: http });
const demo = process.argv.includes("--demo");
let decisionThresholds: DecisionThresholds = DEFAULT_THRESHOLDS;
try { decisionThresholds = { ...DEFAULT_THRESHOLDS, ...JSON.parse(readFileSync("data/nli-thresholds.json", "utf8")) }; } catch { /* Use defaults until eval writes tune-only thresholds. */ }
const maxLives = Number(process.env.RECEIPTS_LIVES ?? 3);
let lives = maxLives, optedIn = false;
let receipt: Receipt | undefined, audioSource: FfmpegPcmSource | undefined, chat: ChatSource;
let eventsubConnected = false, lifetimeReceiptCount = 0;
const buffer = new RollingAudioBuffer(180), transcript: Utterance[] = [], clips = new Map<string, Buffer>();
const clients = new Set<import("ws").WebSocket>();

const receiptStore = new ReceiptStore(resolve("data/receipts"));
function snapshot() { return { lives, maxLives, optedIn, receipt, transcript: transcript.length, embeddingMs: lastEmbeddingLatency, bufferedSeconds: buffer.bufferedSeconds, asr: worker.status, audio: audioSource ? "running" : "stopped", source: chat ? (chat.simulated ? "simulated" : "twitch") : "none", simulated: Boolean(chat?.simulated), eventsubConnected, lifetimeReceiptCount, holdMs: Number(process.env.RECEIPTS_HOLD_MS ?? 5000) }; }
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
async function startAudio(mode: "file" | "device", value: string) {
  await audioSource?.stop();
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
    if (receipt?.outcome === "RECEIPT FOUND" && receipt.status === "pending") {
      receipt.status = "vetoed"; clips.delete(receipt.id); clearTimeout(pendingTimer); sendReply("Receipt vetoed. No clip will play."); broadcast();
    } else sendReply("There is no pending receipt to veto.");
    return;
  }
  const match = text.match(/^!receipts\s+(.{4,240})$/i);
  if (!match) return;
  if (!optedIn) { sendReply("Receipts are opted out by the broadcaster."); return; }
  clearTimeout(pendingTimer);
  if (receipt) clips.delete(receipt.id);
  const query = match[1], start = performance.now();
  void decideClaim(query, message.username, start);
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
  receipt.decisionMs = Number((performance.now() - startedAt).toFixed(1));
  console.log(`Receipt decision completed (${receipt.outcome}, entailment=${receipt.score.toFixed(3)}, candidate=${receipt.candidateId ?? "none"}, retrieval=${receipt.retrievalScore?.toFixed(3) ?? "none"}, decision_ms=${receipt.decisionMs})`);
  if (receipt.outcome === "NO MATCH") { lives = Math.max(0, lives - 1); sendReply(`NO MATCH. Chat loses a life. ${lives} remain.`); }
  else if (receipt.outcome === "CAN'T TELL") sendReply("CAN'T TELL. No life lost.");
  else {
    const foundReceipt = receipt;
    const wavClip = buffer.clip(foundReceipt.clipStart!, foundReceipt.clipEnd!);
    if (!wavClip) { foundReceipt.outcome = "CAN'T TELL"; foundReceipt.reason = "The matching audio is no longer in the rolling buffer"; sendReply("CAN'T TELL. Audio is no longer available; no life lost."); }
    else {
      clips.set(foundReceipt.id, wavClip);
      try { await archiveReceipt(foundReceipt, wavClip); }
      catch (error) { console.error(`[receipts] Could not persist receipt ${foundReceipt.id}: ${(error as Error).message}`); }
    }
    if (foundReceipt.outcome === "RECEIPT FOUND") {
      sendReply("RECEIPT FOUND. Mod veto window is open.");
      const currentId = foundReceipt.id;
      const holdMs = Math.max(0, Number(process.env.RECEIPTS_HOLD_MS ?? 5000));
      foundReceipt.vetoUntil = Date.now() + holdMs;
      pendingTimer = setTimeout(() => {
        if (receipt?.id !== currentId || receipt.status !== "pending") return;
        receipt.status = "played"; receipt.vetoUntil = undefined; broadcast();
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
app.get("/api/state", (_req, res) => res.json(snapshot()));
app.get("/api/clip/:id", async (req, res) => { const clip = clips.get(req.params.id) ?? await receiptStore.clip(req.params.id); if (!clip) return res.sendStatus(404); res.type("audio/wav").send(clip); });
app.get("/api/receipts", async (_req, res) => res.json(await receiptStore.list()));
app.get("/api/receipts/:id/clip", async (req, res) => {
  const clip = await receiptStore.clip(req.params.id);
  if (!clip) return res.sendStatus(404);
  res.type("audio/wav").send(clip);
});
app.post("/api/opt-in", (_req, res) => { optedIn = !optedIn; res.json(snapshot()); broadcast(); });
app.post("/api/simulate", (req, res) => {
  if (!demo || !(chat instanceof SimulatedChatSource)) return res.sendStatus(403);
  const text = String(req.body?.text ?? "").slice(0, 260);
  chat.inject({ userId: "demo-viewer", username: String(req.body?.username ?? "demo_viewer"), text, isMod: req.body?.isMod === true, isBroadcaster: req.body?.isBroadcaster === true });
  res.json({ accepted: true });
});
app.post("/api/veto", (req, res) => {
  if (demo && chat instanceof SimulatedChatSource) processChat({ userId: "demo-mod", username: "demo_mod", text: "!veto", isMod: true, isBroadcaster: false });
  else if (receipt?.outcome === "RECEIPT FOUND" && receipt.status === "pending") { receipt.status = "vetoed"; clips.delete(receipt.id); clearTimeout(pendingTimer); sendReply("Receipt vetoed. No clip will play."); broadcast(); }
  res.json(snapshot());
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
  if (demo) console.log("SIMULATED CHAT is visibly marked on the overlay. Opt in, choose a real speech replay, then submit !receipts <claim>.");
  try { await chat.start(); }
  catch (e) { console.error(`Chat connection failed: ${(e as Error).message}`); }
  const replay = process.env.RECEIPTS_AUDIO;
  if (replay && existsSync(replay)) void startAudio("file", replay).catch(e => console.error(`[audio] ${(e as Error).message}`));
  else console.log("No replay started. Set RECEIPTS_AUDIO or choose a source in /control.");
});

process.on("SIGINT", () => { void audioSource?.stop(); worker.stop(); chat.stop(); http.close(); process.exit(0); });
