import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { WhisperWorker } from "../src/transcriber.js";

interface FakeSidecar {
  child: ChildProcessWithoutNullStreams;
  stdin: PassThrough;
  stdout: PassThrough;
  requests: any[];
}
const sidecars: FakeSidecar[] = [];
function launchFake() {
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  const process = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill(): boolean };
  Object.assign(process, { stdin, stdout, stderr, kill: () => true });
  const requests: any[] = [];
  let partial = "";
  stdin.on("data", data => {
    partial += String(data);
    for (;;) {
      const newline = partial.indexOf("\n"); if (newline < 0) break;
      requests.push(JSON.parse(partial.slice(0, newline))); partial = partial.slice(newline + 1);
    }
  });
  const entry = { child: process as unknown as ChildProcessWithoutNullStreams, stdin, stdout, requests };
  sidecars.push(entry);
  return entry.child;
}
async function waitFor(predicate: () => boolean, message: string) {
  const until = Date.now() + 2500;
  while (!predicate() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(predicate(), message);
}

const worker = new WhisperWorker(() => launchFake());
worker.on("error", () => {});
worker.start();
sidecars[0]!.stdout.write('{"type":"ready","device":"cpu/int8","embedding_model":"test"}\n');
assert.equal(worker.status.state, "ready");
worker.submit({ start: 0, end: 8, pcm: Buffer.alloc(16000) });
await waitFor(() => sidecars[0]!.requests.some(message => message.type === "transcribe"), "first audio chunk was not sent");

sidecars[0]!.stdin.emit("error", new Error("simulated broken pipe"));
sidecars[0]!.child.emit("close", 1, null);
assert.equal(worker.status.state, "restarting");
assert.equal(worker.status.queuedAudioSeconds, 8);
await waitFor(() => sidecars.length === 2, "sidecar was not restarted after the capped backoff");
sidecars[1]!.stdout.write('{"type":"ready","device":"cpu/int8","embedding_model":"test"}\n');
await waitFor(() => sidecars[1]!.requests.some(message => message.type === "transcribe"), "in-flight audio was not replayed after restart");
const replayed = sidecars[1]!.requests.find(message => message.type === "transcribe");
sidecars[1]!.stdout.write(JSON.stringify({ type: "transcript", chunk_id: replayed.chunk_id, start: 0, duration: 8, elapsed_ms: 100, segments: [] }) + "\n");
await waitFor(() => worker.status.queuedChunks === 0, "completed audio did not leave the queue");
assert.equal(worker.status.lastRtf, 0.0125);
worker.stop();
assert.equal(worker.status.state, "stopped");
console.log("ok - sidecar pipe failure preserves audio, reports restart state, and retries queued audio");

const launchEnvironments: NodeJS.ProcessEnv[] = [];
const sidecarCountBeforeCudaTest = sidecars.length;
const cudaWorker = new WhisperWorker((_command, _args, options) => {
  launchEnvironments.push(options.env as NodeJS.ProcessEnv);
  return launchFake();
});
cudaWorker.on("error", () => {});
cudaWorker.start();
sidecars.at(-1)!.child.emit("close", 127, null); // Simulate a native DLL load failure before READY.
await waitFor(() => sidecars.length === sidecarCountBeforeCudaTest + 2, "sidecar did not restart after startup exit");
assert.equal(launchEnvironments[0]!.RECEIPTS_ASR_DEVICE, process.env.RECEIPTS_ASR_DEVICE ?? "cuda");
assert.equal(launchEnvironments[1]!.RECEIPTS_ASR_DEVICE, "cpu", "startup crash under CUDA should retry on CPU");
sidecars.at(-1)!.stdout.write('{"type":"ready","device":"cpu/int8","embedding_model":"test"}\n');
await waitFor(() => cudaWorker.status.state === "ready", "CPU fallback sidecar did not become ready");
cudaWorker.stop();
console.log("ok - startup crash while CUDA is requested relaunches sidecar with CPU");
