import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { FfmpegPcmSource } from "../src/audio.js";
import { decide, type Thresholds } from "../src/matcher.js";
import type { Utterance } from "../src/model.js";
import { WhisperWorker } from "../src/transcriber.js";

interface Claim { id: string; split: "tune" | "held_out"; expected: "RECEIPT FOUND" | "NO MATCH"; claim: string; }
interface Trial { outcome: string; score: number; latency: number; }
const claims = JSON.parse(await readFile("eval/claims.json", "utf8")) as Claim[];
const sourcePath = resolve("data/replay.wav"), referencePath = resolve("data/alice_reference.txt");
const resultPath = resolve("eval/RESULTS.md");
const fastEmbedPath = resolve(".venv/Lib/site-packages/fastembed");

function blocked(reason: string) {
  const report = `# Evaluation results\n\nRun date: ${new Date().toISOString()}\n\n## Status: BLOCKED\n\n${reason}\n\nThe 30 labelled claims are in [claims.json](claims.json), split into 15 threshold-tuning claims and 15 held-out claims. No matcher score was used while authoring them. Because the real transcript and embeddings were not produced, no threshold sweep was run and no outcome, WER, accuracy, wrong-FOUND, or latency number is reported.\n\nReplay fixture preparation did succeed: ${existsSync(sourcePath) ? "data/replay.wav exists (16 kHz mono real LibriVox speech with deterministic noise)." : "the replay WAV is missing."} The separate local E2E attempt also encountered Node spawn EPERM when starting Python, and a direct faster-whisper startup could not write its temporary model download under D:/hf_cache/faster-whisper. The full run command is npm run eval.\n`;
  return writeFile(resultPath, report, "utf8");
}

if (!existsSync(sourcePath) || !existsSync(referencePath)) {
  await blocked("Replay/reference fixtures are missing. Run `.venv\\Scripts\\python.exe eval\\prepare.py` first.");
  console.error("Evaluation fixtures missing; see eval/RESULTS.md"); process.exit(2);
}
if (!existsSync(fastEmbedPath)) {
  await blocked("The existing `.venv` does not contain FastEmbed. The required package is already listed in `asr/requirements.txt`; per workspace instructions this runner does not install packages. Install that requirements file, then rerun. This blocks semantic embeddings and therefore the real claim evaluation.");
  console.error("FastEmbed is missing from the existing .venv; see eval/RESULTS.md"); process.exit(2);
}
if (claims.length !== 30 || claims.filter(c => c.split === "tune").length !== 15 || claims.filter(c => c.split === "held_out").length !== 15) {
  throw new Error("Expected 30 claims split evenly into tune and held_out");
}

const worker = new WhisperWorker();
const transcript: Utterance[] = [];
let readyResolve!: () => void;
let readyReject!: (error: Error) => void;
let isReady = false;
const ready = new Promise<void>((res, rej) => { readyResolve = res; readyReject = rej; });
worker.on("ready", info => { isReady = true; console.log(`ASR ready: ${info}`); readyResolve(); });
worker.on("transcript", (rows: Utterance[]) => transcript.push(...rows));
worker.on("error", (error: Error) => { console.error(`[ASR] ${error.message}`); if (!isReady) readyReject(error); });
try { worker.start(); } catch (error) { await blocked(`The Node process cannot launch the faster-whisper child process here (${(error as Error).message}). No transcript or decision metrics were produced.`); console.error("Speech sidecar could not start; see eval/RESULTS.md"); process.exit(2); }
const source = new FfmpegPcmSource(sourcePath, "file");
let expectedChunks = 0, completedChunks = 0, sourceEnded = false;
worker.on("chunkTranscribed", () => { completedChunks++; });
worker.on("chunkFailed", () => { completedChunks++; });
const done = new Promise<void>((resolveDone, rejectDone) => {
  const check = () => { if (sourceEnded && completedChunks >= expectedChunks) resolveDone(); };
  source.on("chunk", (chunk: { start: number; end: number; pcm: Buffer }) => { expectedChunks++; worker.submit({ start: chunk.start, pcm: chunk.pcm }); });
  source.on("end", code => { if (code !== 0) rejectDone(new Error(`Replay ended with code ${code}`)); sourceEnded = true; check(); });
  source.on("error", rejectDone);
  worker.on("chunkTranscribed", check); worker.on("chunkFailed", check);
});
let startupTimer: ReturnType<typeof setTimeout> | undefined;
try { await Promise.race([ready, new Promise<void>((_, reject) => { startupTimer = setTimeout(() => reject(new Error("Speech worker startup timed out")), 900_000); })]); } catch (error) { await blocked(`The faster-whisper sidecar did not become ready (${(error as Error).message}). No transcript or decision metrics were produced.`); console.error("Speech sidecar failed; see eval/RESULTS.md"); process.exit(2); } finally { if (startupTimer) clearTimeout(startupTimer); }
await source.start();
console.log("Real-time replay started; waiting for the complete recording and transcript.");
await done;

const tune = claims.filter(c => c.split === "tune"), held = claims.filter(c => c.split === "held_out");
const vectors = new Map<string, { vector: number[]; embeddingMs: number }>();
for (const claim of claims) {
  const started = performance.now(), vector = await worker.embed(claim.claim);
  vectors.set(claim.id, { vector, embeddingMs: performance.now() - started });
}
const runTrial = (claim: Claim, thresholds: Thresholds): Trial => {
  const cached = vectors.get(claim.id)!;
  const started = performance.now();
  const receipt = decide(claim.claim, transcript, "eval", randomUUID(), cached.vector, thresholds);
  return { outcome: receipt.outcome, score: receipt.score, latency: cached.embeddingMs + performance.now() - started };
};
const grid: Thresholds[] = [];
for (let found = 0.45; found <= 0.8501; found += 0.05)
  for (let miss = 0.10; miss <= Math.min(0.40, found - 0.1); miss += 0.05) grid.push({ found: Number(found.toFixed(2)), miss: Number(miss.toFixed(2)) });
let chosen: Thresholds = { found: 0.62, miss: 0.28 }, bestCorrect = -1;
for (const thresholds of grid) {
  const trials = tune.map(c => runTrial(c, thresholds));
  const falseFound = trials.filter((t, i) => tune[i]!.expected === "NO MATCH" && t.outcome === "RECEIPT FOUND").length;
  const correct = trials.filter((t, i) => t.outcome === tune[i]!.expected).length;
  if (falseFound === 0 && correct > bestCorrect) { chosen = thresholds; bestCorrect = correct; }
}
const heldTrials = held.map(c => runTrial(c, chosen));
const tuneTrials = tune.map(c => runTrial(c, chosen));
const allTrials = [...tuneTrials, ...heldTrials];
worker.stop();
const wrongFound = heldTrials.filter((t, i) => held[i]!.expected === "NO MATCH" && t.outcome === "RECEIPT FOUND").length;
const correct = heldTrials.filter((t, i) => t.outcome === held[i]!.expected).length;
const counts = Object.fromEntries(["RECEIPT FOUND", "NO MATCH", "CAN'T TELL"].map(outcome => [outcome, heldTrials.filter(t => t.outcome === outcome).length]));
const overallCounts = Object.fromEntries(["RECEIPT FOUND", "NO MATCH", "CAN'T TELL"].map(outcome => [outcome, allTrials.filter(t => t.outcome === outcome).length]));

function tokens(text: string) { return text.toLowerCase().replace(/[^a-z0-9']+/g, " ").trim().split(/\s+/).filter(Boolean); }
const referenceText = await readFile(referencePath, "utf8");
const chapterStarts = [...referenceText.matchAll(/\n\s*CHAPTER I\.\s*/gi)];
const firstChapter = chapterStarts.length > 1 ? chapterStarts[1]!.index! : -1;
const nextChapter = referenceText.indexOf("CHAPTER II.", firstChapter + 10);
const refTokens = tokens(referenceText.slice(firstChapter, nextChapter));
const hypTokens = tokens(transcript.map(row => row.text).join(" "));
let prev = Array.from({ length: hypTokens.length + 1 }, (_, i) => i);
for (let i = 1; i <= refTokens.length; i++) {
  const row = [i];
  for (let j = 1; j <= hypTokens.length; j++) row[j] = Math.min(row[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + (refTokens[i - 1] === hypTokens[j - 1] ? 0 : 1));
  prev = row;
}
const wer = refTokens.length ? prev[hypTokens.length]! / refTokens.length : NaN;
const latency = allTrials.map(t => t.latency).sort((a, b) => a - b);
const p95 = latency[Math.min(latency.length - 1, Math.ceil(latency.length * 0.95) - 1)] ?? 0;
const countWrongFound = heldTrials.filter((t, i) => held[i]!.expected === "NO MATCH" && t.outcome === "RECEIPT FOUND").length;
const overallCorrect = correct + tuneTrials.filter((t, i) => t.outcome === tune[i]!.expected).length;
const report = `# Evaluation results\n\nRun date: ${new Date().toISOString()}\n\n## Setup\n\n- Public-domain speech: LibriVox / Internet Archive Chapter 1; real-time replay through FfmpegPcmSource and the faster-whisper sidecar.\n- Noise: deterministic synthesized bed and chirps, seed 20261101.\n- Claims: 15 tuning and 15 held-out; held-out claims were not used for threshold selection.\n- Thresholds selected on tune half: found ${chosen.found.toFixed(2)}, miss ${chosen.miss.toFixed(2)}; tune correct ${bestCorrect}/15 with zero tune false FOUND.\n\n## Held-out results (n=15)\n\n- Outcome counts, held out: RECEIPT FOUND ${counts["RECEIPT FOUND"]}, NO MATCH ${counts["NO MATCH"]}, CAN'T TELL ${counts["CAN'T TELL"]}.\n- Outcome counts, all 30: RECEIPT FOUND ${overallCounts["RECEIPT FOUND"]}, NO MATCH ${overallCounts["NO MATCH"]}, CAN'T TELL ${overallCounts["CAN'T TELL"]}.\n- Correct outcomes: ${correct}/15 held out; ${overallCorrect}/30 overall.\n- Wrong RECEIPT FOUND: ${wrongFound} held out (0 on tune half by threshold selection).\n- Transcript WER against Gutenberg Chapter I: ${(wer * 100).toFixed(2)}% (${prev[hypTokens.length]} edit errors / ${refTokens.length} reference words).\n- Claim-to-decision latency: mean ${(allTrials.reduce((sum, t) => sum + t.latency, 0) / allTrials.length).toFixed(1)} ms, p95 ${p95.toFixed(1)} ms.\n\n## Target\n\n${countWrongFound === 0 && overallCorrect >= 21 ? "Target met (0 wrong FOUND in held-out and at least 21/30 overall)." : "Target not met. Report the actual held-out false FOUND and overall correct counts above; improve without tuning against held-out examples."}\n`;
await writeFile(resultPath, report, "utf8");
console.log(report);
