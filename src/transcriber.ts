import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { Utterance } from "./model.js";

interface PendingEmbedding { resolve: (vector: number[]) => void; reject: (error: Error) => void; }
export class WhisperWorker extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private ready = false;
  private failed = false;
  private queuedChunks: Array<{ start: number; pcm: Buffer }> = [];
  private pending = new Map<string, PendingEmbedding>();
  start() {
    if (this.child) return;
    const python = process.env.PYTHON ?? resolve(".venv", "Scripts", "python.exe");
    try { this.child = spawn(python, ["asr/worker.py"], { windowsHide: true, env: { ...process.env, HF_HOME: process.env.HF_HOME ?? "D:/hf_cache", FASTEMBED_CACHE_PATH: process.env.FASTEMBED_CACHE_PATH ?? "D:/hf_cache/fastembed" } }); }
    catch (error) { this.failed = true; throw error; }
    this.child.stderr.on("data", d => this.emit("log", String(d).trim()));
    this.child.on("error", e => this.emit("error", e));
    createInterface({ input: this.child.stdout }).on("line", line => {
      try {
        const message = JSON.parse(line);
        if (message.type === "ready") {
          this.ready = true; this.emit("ready", `${message.device}; ${message.embedding_model}`);
          for (const chunk of this.queuedChunks.splice(0)) this.write({ type: "transcribe", ...chunk });
        } else if (message.type === "transcript") {
          this.emit("transcript", message.segments as Utterance[]);
          this.emit("chunkTranscribed", Number(message.start));
        }
        else if (message.type === "embedding") {
          const p = this.pending.get(message.request_id); if (p) { this.pending.delete(message.request_id); p.resolve(message.vector as number[]); }
          this.emit("embeddingLatency", Number(message.elapsed_ms));
        } else if (message.type === "error") {
          const error = new Error(message.message);
          if (message.request_id && this.pending.has(message.request_id)) { this.pending.get(message.request_id)!.reject(error); this.pending.delete(message.request_id); }
          else { if (Number.isFinite(message.start)) this.emit("chunkFailed", Number(message.start), error); this.emit("error", error); }
        } else this.emit("log", message.message);
      } catch { this.emit("log", line); }
    });
    this.child.on("close", code => {
      this.ready = false; this.child = undefined;
      for (const p of this.pending.values()) p.reject(new Error(`Local speech worker exited (${code})`));
      this.pending.clear();
      if (code !== 0) this.emit("error", new Error(`Local speech worker exited (${code})`));
    });
  }
  private write(value: unknown) { if (this.child?.stdin.writable) this.child.stdin.write(JSON.stringify(value) + "\n"); }
  submit(chunk: { start: number; pcm: Buffer }) {
    if (this.failed) return;
    if (this.ready) this.write({ type: "transcribe", start: chunk.start, pcm: chunk.pcm.toString("base64") });
    else this.queuedChunks.push(chunk);
  }
  embed(text: string): Promise<number[]> {
    if (this.failed) return Promise.reject(new Error("Local speech sidecar could not start"));
    if (!this.ready) return Promise.reject(new Error("Local sentence model is still loading"));
    const request_id = randomUUID();
    return new Promise((resolveEmbedding, reject) => {
      this.pending.set(request_id, { resolve: resolveEmbedding, reject });
      this.write({ type: "embed", request_id, text });
    });
  }
  stop() { this.child?.kill(); }
}
