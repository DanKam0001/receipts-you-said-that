import assert from "node:assert/strict";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { FfmpegPcmSource, wav } from "../src/audio.js";

await mkdir(".tmp", { recursive: true });
const path = ".tmp/replay-source-test.wav";
const original = Buffer.alloc(8000, 7);
await writeFile(path, wav(original));
const source = new FfmpegPcmSource(path, "file");
let received = Buffer.alloc(0), chunks = 0;
const ended = new Promise<number>((resolve, reject) => {
  source.on("chunk", chunk => { received = Buffer.concat([received, chunk.pcm]); chunks++; });
  source.on("end", code => resolve(code));
  source.on("error", reject);
});
await source.start();
assert.equal(await ended, 0);
assert.equal(chunks, 1);
assert.deepEqual(received, original);
assert.equal(source.listenerCount("error"), 1);
await unlink(path);
console.log("ok - normalized WAV replay emits identical PCM and closes cleanly");
