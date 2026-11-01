import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import type { Utterance } from "./model.js";

export class WhisperWorker extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private ready = false;
  start() {
    if (this.child) return;
    this.child = spawn(process.env.PYTHON ?? "python", ["asr/worker.py"], { windowsHide: true, env: process.env });
    this.child.stderr.on("data", d => this.emit("log", String(d).trim()));
    this.child.on("error", e => this.emit("error", e));
    createInterface({ input: this.child.stdout }).on("line", line => {
      try {
        const message = JSON.parse(line);
        if (message.type === "ready") { this.ready = true; this.emit("ready", message.device); }
        else if (message.type === "transcript") this.emit("transcript", message.segments as Utterance[]);
        else if (message.type === "error") this.emit("error", new Error(message.message));
        else this.emit("log", message.message);
      } catch { this.emit("log", line); }
    });
    this.child.on("close", code => { this.ready = false; this.child = undefined; if (code !== 0) this.emit("error", new Error(`faster-whisper worker exited (${code})`)); });
  }
  submit(chunk: { start: number; pcm: Buffer }) {
    if (this.ready && this.child?.stdin.writable) this.child.stdin.write(JSON.stringify({ start: chunk.start, pcm: chunk.pcm.toString("base64") }) + "\n");
  }
  stop() { this.child?.kill(); }
}
