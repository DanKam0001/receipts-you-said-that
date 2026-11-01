import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface AudioSource { start(): Promise<void>; stop(): Promise<void>; }
export class FfmpegPcmSource extends EventEmitter implements AudioSource {
  private proc?: ChildProcessWithoutNullStreams;
  private pending = Buffer.alloc(0);
  private sampleCursor = 0;
  private replayTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  constructor(private readonly input: string, private readonly mode: "file" | "device") { super(); }
  async start() {
    this.stopped = false;
    this.sampleCursor = 0;
    this.pending = Buffer.alloc(0);
    if (this.mode === "file" && this.input.toLowerCase().endsWith(".wav")) {
      const file = await readFile(resolve(this.input));
      const pcm = this.wavPcm(file);
      if (pcm) { this.feedRealtime(pcm); return; }
    }
    const args = this.mode === "file"
      ? ["-hide_banner", "-loglevel", "error", "-re", "-i", resolve(this.input), "-vn", "-f", "s16le", "-ac", "1", "-ar", "16000", "pipe:1"]
      : ["-hide_banner", "-loglevel", "error", "-f", "dshow", "-i", `audio=${this.input}`, "-f", "s16le", "-ac", "1", "-ar", "16000", "pipe:1"];
    if (this.mode === "file" && !existsSync(this.input)) throw new Error(`Replay file not found: ${this.input}`);
    try { this.proc = spawn(process.env.FFMPEG_PATH ?? "ffmpeg", args, { windowsHide: true }); }
    catch (error) { throw new Error(`Unable to start FFmpeg (${(error as Error).message})`); }
    this.proc.stderr.on("data", data => this.emit("error", new Error(String(data).trim())));
    this.proc.on("error", e => this.emit("error", e));
    this.proc.on("close", code => {
      if (this.pending.length >= 2) {
        const pcm = this.pending; this.pending = Buffer.alloc(0);
        const start = this.sampleCursor / 16000; this.sampleCursor += pcm.length / 2;
        this.emit("chunk", { start, end: this.sampleCursor / 16000, pcm });
      }
      this.emit("end", code);
    });
    this.proc.stdout.on("data", (data: Buffer) => this.consume(data));
  }
  private wavPcm(file: Buffer): Buffer | undefined {
    if (file.length < 44 || file.toString("ascii", 0, 4) !== "RIFF" || file.toString("ascii", 8, 12) !== "WAVE") return undefined;
    let offset = 12, format = 0, channels = 0, rate = 0, bits = 0, data: Buffer | undefined;
    while (offset + 8 <= file.length) {
      const name = file.toString("ascii", offset, offset + 4), size = file.readUInt32LE(offset + 4), body = offset + 8;
      if (body + size > file.length) return undefined;
      if (name === "fmt " && size >= 16) { format = file.readUInt16LE(body); channels = file.readUInt16LE(body + 2); rate = file.readUInt32LE(body + 4); bits = file.readUInt16LE(body + 14); }
      if (name === "data") data = file.subarray(body, body + size);
      offset = body + size + (size % 2);
    }
    return format === 1 && channels === 1 && rate === 16000 && bits === 16 ? data : undefined;
  }
  private feedRealtime(pcm: Buffer) {
    const chunkBytes = 16000 * 2 * 8;
    const pump = () => {
      if (this.stopped) return;
      const chunk = pcm.subarray(this.sampleCursor * 2, Math.min(pcm.length, this.sampleCursor * 2 + chunkBytes));
      if (!chunk.length) { this.emit("end", 0); return; }
      const start = this.sampleCursor / 16000;
      this.sampleCursor += chunk.length / 2;
      this.emit("chunk", { start, end: this.sampleCursor / 16000, pcm: chunk });
      this.replayTimer = setTimeout(pump, chunk.length / 32000 * 1000);
    };
    pump();
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
  async stop() { this.stopped = true; if (this.replayTimer) clearTimeout(this.replayTimer); this.proc?.kill(); }
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
  get bufferedSeconds() { return this.chunks.length ? this.chunks[this.chunks.length - 1]!.end - this.chunks[0]!.start : 0; }
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
