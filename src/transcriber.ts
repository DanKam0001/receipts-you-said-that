import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { Utterance } from "./model.js";
import type { NliProbabilities } from "./matcher.js";

export type AsrState = "stopped" | "starting" | "ready" | "degraded" | "restarting";
export interface AsrStatus {
  state: AsrState;
  device?: string;
  message: string;
  queuedAudioSeconds: number;
  inFlightAudioSeconds: number;
  lagSeconds: number;
  queuedChunks: number;
  lastTranscribeMs?: number;
  lastRtf?: number;
}
interface AudioChunk { id: string; start: number; duration: number; pcm: Buffer; }
interface PendingRequest { resolve: (value: any) => void; reject: (error: Error) => void; }
export type SidecarLauncher = (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;

const MAX_RESTART_MS = 30_000;

export class WhisperWorker extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private ready = false;
  private running = false;
  private restartAttempts = 0;
  private currentSidecarReady = false;
  private cpuStartupFallback = false;
  private restartTimer?: ReturnType<typeof setTimeout>;
  private queue: AudioChunk[] = [];
  private inFlight?: AudioChunk;
  private pending = new Map<string, PendingRequest>();
  private statusValue: AsrStatus = { state: "stopped", message: "Speech recognition stopped", queuedAudioSeconds: 0, inFlightAudioSeconds: 0, lagSeconds: 0, queuedChunks: 0 };

  constructor(private readonly launch: SidecarLauncher = (command, args, options) => spawn(command, args, options)) { super(); }

  get status(): AsrStatus { return { ...this.statusValue }; }

  start() {
    if (this.running) return;
    this.running = true;
    this.launchSidecar();
  }

  private setStatus(state: AsrState, message: string, device?: string) {
    const queuedAudioSeconds = this.queue.reduce((n, chunk) => n + chunk.duration, 0);
    this.statusValue = { state, device, message, queuedAudioSeconds, inFlightAudioSeconds: this.inFlight?.duration ?? 0, lagSeconds: queuedAudioSeconds,
      queuedChunks: this.queue.length + (this.inFlight ? 1 : 0), lastTranscribeMs: this.statusValue.lastTranscribeMs, lastRtf: this.statusValue.lastRtf };
    this.emit("status", this.status);
  }

  private reportError(error: Error) {
    if (this.listenerCount("error")) this.emit("error", error);
    else this.emit("log", error.message);
  }

  private launchSidecar() {
    if (!this.running || this.child) return;
    this.setStatus(this.restartAttempts ? "restarting" : "starting", this.restartAttempts ? "Restarting local speech sidecar" : "Starting local speech sidecar");
    const python = process.env.PYTHON ?? resolve(".venv", "Scripts", "python.exe");
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.launch(python, ["asr/worker.py"], { windowsHide: true, env: { ...process.env,
        HF_HOME: process.env.HF_HOME ?? "D:/hf_cache",
        FASTEMBED_CACHE_PATH: process.env.FASTEMBED_CACHE_PATH ?? "D:/hf_cache/fastembed",
        RECEIPTS_SKIP_ASR: process.env.RECEIPTS_SKIP_ASR ?? "0",
        RECEIPTS_ASR_DEVICE: this.cpuStartupFallback ? "cpu" : (process.env.RECEIPTS_ASR_DEVICE ?? "cuda") } });
    } catch (error) {
      this.sidecarFailed(undefined, error as Error);
      return;
    }
    this.child = child;
    child.stdin.on("error", error => this.sidecarFailed(child, new Error(`ASR stdin pipe failed: ${error.message}`)));
    child.stdout.on("error", error => this.sidecarFailed(child, new Error(`ASR stdout pipe failed: ${error.message}`)));
    child.stderr.on("error", error => this.sidecarFailed(child, new Error(`ASR stderr pipe failed: ${error.message}`)));
    child.stderr.on("data", data => this.emit("log", String(data).trim()));
    child.on("error", error => this.sidecarFailed(child, new Error(`ASR process failed: ${error.message}`)));
    const lines = createInterface({ input: child.stdout });
    lines.on("line", line => this.handleLine(child, line));
    lines.on("error", error => this.sidecarFailed(child, new Error(`ASR output reader failed: ${error.message}`)));
    child.on("close", code => this.sidecarFailed(child, new Error(`Speech sidecar exited (${code ?? "unknown"})`)));
  }

  private sidecarFailed(child: ChildProcessWithoutNullStreams | undefined, error: Error) {
    if (child && this.child !== child) return;
    const failedDuringStartup = !!child && !this.currentSidecarReady;
    this.currentSidecarReady = false;
    if (child) {
      this.child = undefined;
      if (child.exitCode === null || child.exitCode === undefined) { try { child.kill(); } catch { /* Exit and retry even if already gone. */ } }
    }
    this.ready = false;
    if (this.inFlight) { this.queue.unshift(this.inFlight); this.inFlight = undefined; }
    for (const entry of this.pending.values()) entry.reject(new Error("Speech sidecar restarted during embedding"));
    this.pending.clear();
    if (failedDuringStartup && (process.env.RECEIPTS_ASR_DEVICE ?? "cuda") === "cuda" && !this.cpuStartupFallback) {
      this.cpuStartupFallback = true;
      error = new Error(`${error.message}; CUDA sidecar exited during startup, retrying with CPU int8`);
    }
    this.reportError(error);
    if (!this.running) { this.setStatus("stopped", error.message); return; }
    const delay = Math.min(500 * (2 ** this.restartAttempts), MAX_RESTART_MS);
    this.restartAttempts++;
    const queuedSeconds = this.queue.reduce((n, chunk) => n + chunk.duration, 0);
    this.setStatus("restarting", `${error.message}. Retrying in ${(delay / 1000).toFixed(1)}s; preserving ${queuedSeconds.toFixed(1)}s queued audio.`);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => { this.restartTimer = undefined; this.launchSidecar(); }, delay);
  }

  private handleLine(child: ChildProcessWithoutNullStreams, line: string) {
    if (this.child !== child) return;
    let message: any;
    try { message = JSON.parse(line); }
    catch { this.emit("log", `Ignored malformed ASR sidecar output (${line.length} characters)`); return; }
    if (message.type === "ready") {
      this.ready = true;
      this.currentSidecarReady = true;
      this.setStatus("ready", `Local faster-whisper ready (${message.device}); NLI ${message.nli_model ?? "unavailable"}`, String(message.device));
      this.emit("ready", `${message.device}; embeddings ${message.embedding_model}; NLI ${message.nli_model ?? "unavailable"}`);
      this.flushQueue();
    } else if (message.type === "status") this.emit("log", String(message.message));
    else if (message.type === "transcript") {
      if (!this.inFlight || message.chunk_id !== this.inFlight.id) return;
      const chunk = this.inFlight; this.inFlight = undefined;
      const elapsed = Number(message.elapsed_ms);
      this.statusValue.lastTranscribeMs = Number.isFinite(elapsed) ? elapsed : undefined;
      this.statusValue.lastRtf = Number.isFinite(elapsed) && chunk.duration > 0 ? elapsed / (chunk.duration * 1000) : undefined;
      this.emit("transcript", message.segments as Utterance[]);
      this.emit("chunkTranscribed", chunk.start, elapsed, this.statusValue.lastRtf);
      if (this.statusValue.lastRtf !== undefined && this.statusValue.lastRtf > 1)
        this.emit("log", `ASR is behind real time: last chunk RTF ${this.statusValue.lastRtf.toFixed(2)}; ${this.queue.reduce((n, c) => n + c.duration, 0).toFixed(1)}s queued`);
      this.restartAttempts = 0;
      this.setStatus("ready", this.statusValue.lastRtf !== undefined && this.statusValue.lastRtf > 1
        ? `Transcription is behind real time (RTF ${this.statusValue.lastRtf.toFixed(2)})` : `Transcription keeping pace (RTF ${(this.statusValue.lastRtf ?? 0).toFixed(2)})`, this.statusValue.device);
      this.flushQueue();
    } else if (message.type === "embedding") {
      const pending = this.pending.get(message.request_id);
      if (pending) { this.pending.delete(message.request_id); pending.resolve(message.vector as number[]); }
      this.emit("embeddingLatency", Number(message.elapsed_ms));
    } else if (message.type === "verified") {
      const pending = this.pending.get(message.request_id);
      if (pending) { this.pending.delete(message.request_id); pending.resolve(message.pairs as NliProbabilities[]); }
      this.emit("verificationLatency", Number(message.elapsed_ms), Number(message.mean_pair_ms), Number(message.pair_count));
    } else if (message.type === "error") {
      const error = new Error(String(message.message ?? "ASR sidecar request failed"));
      if (message.request_id && this.pending.has(message.request_id)) {
        this.pending.get(message.request_id)!.reject(error); this.pending.delete(message.request_id); this.reportError(error);
      } else if (this.inFlight && message.chunk_id === this.inFlight.id) {
        const chunk = this.inFlight; this.inFlight = undefined;
        this.emit("chunkFailed", chunk.start, error);
        this.setStatus("degraded", `A ${chunk.duration.toFixed(1)}s audio chunk failed transcription: ${error.message}`, this.statusValue.device);
        this.reportError(error); this.flushQueue();
      } else this.reportError(error);
    }
  }

  private write(message: unknown, child = this.child) {
    if (!child || child !== this.child || !child.stdin.writable) return false;
    try {
      child.stdin.write(JSON.stringify(message) + "\n", error => { if (error) this.sidecarFailed(child, new Error(`ASR stdin write failed: ${error.message}`)); });
      return true;
    } catch (error) { this.sidecarFailed(child, new Error(`ASR stdin write failed: ${(error as Error).message}`)); return false; }
  }

  private flushQueue() {
    if (!this.running || !this.ready || this.inFlight || !this.queue.length) return;
    const chunk = this.queue.shift()!; this.inFlight = chunk;
    this.setStatus("ready", `Transcribing; ${this.statusValue.queuedAudioSeconds.toFixed(1)}s audio queued`, this.statusValue.device);
    this.write({ type: "transcribe", chunk_id: chunk.id, start: chunk.start, duration: chunk.duration, pcm: chunk.pcm.toString("base64") });
  }

  submit(chunk: { start: number; end: number; pcm: Buffer }) {
    if (!this.running) this.start();
    this.queue.push({ id: randomUUID(), start: chunk.start, duration: Math.max(0, chunk.end - chunk.start), pcm: chunk.pcm });
    this.setStatus(this.ready ? "ready" : (this.restartAttempts ? "restarting" : "starting"),
      `${this.statusValue.queuedAudioSeconds.toFixed(1)}s of audio waiting for local transcription`, this.statusValue.device);
    this.flushQueue();
  }

  embed(text: string): Promise<number[]> {
    if (!this.ready || !this.child) return Promise.reject(new Error("Local sentence model is not ready"));
    const request_id = randomUUID();
    return new Promise((resolveEmbedding, reject) => {
      this.pending.set(request_id, { resolve: resolveEmbedding, reject });
      if (!this.write({ type: "embed", request_id, text })) {
        this.pending.delete(request_id); reject(new Error("Unable to send embedding request to local speech sidecar"));
      }
    });
  }

  verify(pairs: { premise: string; hypothesis: string }[]): Promise<NliProbabilities[]> {
    if (!this.ready || !this.child) return Promise.reject(new Error("Local NLI verifier is not ready"));
    if (!pairs.length) return Promise.resolve([]);
    const request_id = randomUUID();
    return new Promise((resolveVerification, reject) => {
      this.pending.set(request_id, { resolve: resolveVerification, reject });
      if (!this.write({ type: "verify", request_id, pairs })) {
        this.pending.delete(request_id); reject(new Error("Unable to send NLI request to local speech sidecar"));
      }
    });
  }

  stop() {
    this.running = false; this.ready = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    const child = this.child; this.child = undefined;
    child?.kill();
    for (const entry of this.pending.values()) entry.reject(new Error("Speech sidecar stopped"));
    this.pending.clear();
    this.setStatus("stopped", "Speech recognition stopped");
  }
}
