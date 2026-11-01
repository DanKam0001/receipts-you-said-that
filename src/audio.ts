import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export interface AudioSource { start(): Promise<void>; stop(): Promise<void>; }
export class FfmpegPcmSource extends EventEmitter implements AudioSource {
  private proc?: ChildProcessWithoutNullStreams;
  private pending = Buffer.alloc(0);
  private sampleCursor = 0;
  constructor(private readonly input: string, private readonly mode: "file" | "device") { super(); }
  async start() {
    const args = this.mode === "file"
      ? ["-hide_banner", "-loglevel", "error", "-re", "-i", resolve(this.input), "-vn", "-f", "s16le", "-ac", "1", "-ar", "16000", "pipe:1"]
      : ["-hide_banner", "-loglevel", "error", "-f", "dshow", "-i", `audio=${this.input}`, "-f", "s16le", "-ac", "1", "-ar", "16000", "pipe:1"];
    if (this.mode === "file" && !existsSync(this.input)) throw new Error(`Replay file not found: ${this.input}`);
    this.proc = spawn("ffmpeg", args, { windowsHide: true });
    this.proc.stderr.on("data", data => this.emit("error", new Error(String(data).trim())));
    this.proc.on("error", e => this.emit("error", e));
    this.proc.on("close", code => this.emit("end", code));
    this.proc.stdout.on("data", (data: Buffer) => this.consume(data));
  }
  private consume(data: Buffer) {
    this.pending = Buffer.concat([this.pending, data]);
    const chunkBytes = 16000 * 2 * 8;
    while (this.pending.length >= chunkBytes) {
      const pcm = this.pending.subarray(0, chunkBytes); this.pending = this.pending.subarray(chunkBytes);
      const start = this.sampleCursor / 16000; this.sampleCursor += pcm.length / 2;
      this.emit("chunk", { start, end: this.sampleCursor / 16000, pcm });
    }
  }
  async stop() { this.proc?.kill(); }
}

export function wav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44); header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(pcm.length, 40); return Buffer.concat([header, pcm]);
}

export class RollingAudioBuffer {
  private chunks: Array<{ start: number; end: number; pcm: Buffer }> = [];
  constructor(private readonly maxSeconds = 180) {}
  push(chunk: { start: number; end: number; pcm: Buffer }) {
    this.chunks.push(chunk); const cutoff = chunk.end - this.maxSeconds;
    this.chunks = this.chunks.filter(c => c.end > cutoff).map(c => {
      if (c.start >= cutoff) return c;
      const skip = Math.max(0, Math.floor((cutoff - c.start) * 16000)) * 2;
      return { start: cutoff, end: c.end, pcm: c.pcm.subarray(skip) };
    });
  }
  clip(start: number, end: number): Buffer | undefined {
    const selected = this.chunks.filter(c => c.end > start && c.start < end);
    if (!selected.length) return undefined;
    const pieces = selected.map(c => {
      const from = Math.max(0, Math.floor((start - c.start) * 16000)) * 2;
      const to = Math.min(c.pcm.length / 2, Math.ceil((end - c.start) * 16000)) * 2;
      return c.pcm.subarray(from, to);
    });
    return wav(Buffer.concat(pieces));
  }
}
