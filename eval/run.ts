import { existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { FfmpegPcmSource } from "../src/audio.js";
import { decide, type Thresholds } from "../src/matcher.js";
import type { Utterance } from "../src/model.js";
import { WhisperWorker } from "../src/transcriber.js";
import { ReplayCompletion } from "../src/replay-completion.js";

interface Claim { id: string; split: "tune" | "held_out"; expected: "RECEIPT FOUND" | "NO MATCH"; claim: string; }
interface Trial { outcome: string; score: number; latency: number; }
interface TranscriptCache { version: 2; sourceBytes: number; sourceMtimeMs: number; asrModel: string; device: string; meanRtf: number; maxRtf: number; p95Rtf: number; transcript: Utterance[]; }
const resultPath = resolve("eval/RESULTS.md"), sourcePath = resolve("data/replay.wav"), referencePath = resolve("data/alice_reference.txt");
const cachePath = resolve("data/eval-transcript-cache.json"), fastEmbedPath = resolve(".venv/Lib/site-packages/fastembed");
let evaluationClaims: Claim[] = [];
let activeWorker: WhisperWorker | undefined, activeSource: FfmpegPcmSource | undefined;

async function writeBlocked(reason: string) {
  if (!evaluationClaims.length && existsSync("eval/claims.json")) {
    try { evaluationClaims = JSON.parse(await readFile("eval/claims.json", "utf8")) as Claim[]; } catch { /* Preserve the primary evaluation failure. */ }
  }
  const held = evaluationClaims.filter(claim => claim.split === "held_out");
  const rows = held.map(claim => `| ${claim.id} | ${claim.claim.replaceAll("|", "\\|")} | ${claim.expected} | N/A | N/A |`).join("\n");
  const table = held.length ? `\n\n## Held-out claims\n\n| ID | Claim | Expected | Actual | Score |\n|---|---|---|---|---:|\n${rows}` : "";
  await writeFile(resultPath, `# Evaluation results\n\nRun date: ${new Date().toISOString()}\n\n## Status: BLOCKED\n\n${reason}\n\nNo evaluation metrics are reported for this blocked run. Transcript cache: ${existsSync(cachePath) ? "present but not verified/used" : "not present"}. The replay fixture ${existsSync(sourcePath) ? "is present" : "is missing"}.${table}\n`, "utf8");
}

async function waitForReady(worker: WhisperWorker) {
  await new Promise<void>((resolveReady, rejectReady) => {
    let settled = false;
    const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); worker.off("ready", onReady); worker.off("error", onError); error ? rejectReady(error) : resolveReady(); };
    const onReady = () => finish();
    const onError = (error: Error) => { if (worker.status.state !== "ready") finish(error); };
    const timer = setTimeout(() => finish(new Error("ASR sidecar startup timed out after 15 minutes")), 900_000);
    worker.on("ready", onReady); worker.on("error", onError);
    if (worker.status.state === "ready") finish();
  });
}

async function main() {
  evaluationClaims = JSON.parse(await readFile("eval/claims.json", "utf8")) as Claim[];
  if (!existsSync(sourcePath) || !existsSync(referencePath)) throw new Error("Replay/reference fixtures are missing; run .venv\\Scripts\\python.exe eval\\prepare.py first");
  if (!existsSync(fastEmbedPath)) throw new Error("FastEmbed is missing from the existing .venv; install the packages already listed in asr/requirements.txt");
  const tune = evaluationClaims.filter(claim => claim.split === "tune"), held = evaluationClaims.filter(claim => claim.split === "held_out");
  if (evaluationClaims.length !== 30 || tune.length !== 15 || held.length !== 15) throw new Error("Expected 30 claims split evenly into tune and held_out");

  const sourceStats = await stat(sourcePath), asrModel = process.env.RECEIPTS_ASR_MODEL ?? "small.en";
  const fast = process.argv.includes("--fast");
  let transcript: Utterance[] = [], cacheUsed = false, device = "unknown", meanRtf = 0, maxRtf = 0, p95Rtf = 0;
  if (existsSync(cachePath)) {
    const cached = JSON.parse(await readFile(cachePath, "utf8")) as TranscriptCache;
    if (cached.version === 2 && cached.sourceBytes === sourceStats.size && cached.sourceMtimeMs === sourceStats.mtimeMs && cached.asrModel === asrModel) {
      transcript = cached.transcript; cacheUsed = true; device = cached.device; meanRtf = cached.meanRtf; maxRtf = cached.maxRtf; p95Rtf = cached.p95Rtf;
    }
  }

  const worker = new WhisperWorker(); activeWorker = worker;
  const transcribeRtfs: number[] = [], chunkFailures: string[] = [];
  worker.on("transcript", (rows: Utterance[]) => transcript.push(...rows));
  worker.on("chunkTranscribed", (_start: number, _elapsedMs?: number, rtf?: number) => { if (rtf !== undefined) transcribeRtfs.push(rtf); });
  worker.on("chunkFailed", (start: number, error: Error) => chunkFailures.push(`audio at ${start.toFixed(1)}s: ${error.message}`));
  worker.on("log", message => console.log(`[ASR] ${message}`));
  worker.on("error", error => console.error(`[ASR] ${error.message}`));
  worker.start();
  await waitForReady(worker);
  device = worker.status.device ?? "unknown";

  if (!cacheUsed) {
    const startedAt = performance.now();
    const source = new FfmpegPcmSource(sourcePath, "file", { realtime: !fast }); activeSource = source;
    const progress = new ReplayCompletion();
    await new Promise<void>((resolveDone, rejectDone) => {
      let settled = false;
      let watchdog: ReturnType<typeof setTimeout>;
      const cleanup = () => { clearTimeout(watchdog); worker.off("chunkTranscribed", onChunkFinished); worker.off("chunkFailed", onChunkFailed); source.off("chunk", onChunk); source.off("end", onEnd); source.off("error", onError); };
      const finish = (error?: Error) => { if (settled) return; settled = true; cleanup(); error ? rejectDone(error) : resolveDone(); };
      const armWatchdog = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => finish(new Error(`No ASR chunk completed for 120 seconds; queue state: ${JSON.stringify(worker.status)}`)), 120_000);
      };
      const check = () => { const state = progress.counts; if (state.ended && state.completed >= state.expected) finish(); };
      const onChunk = (chunk: Parameters<typeof worker.submit>[0]) => { progress.addChunk(); worker.submit(chunk); };
      const onChunkFinished = () => {
        progress.finishChunk(); armWatchdog();
        if (progress.counts.completed % 10 === 0) console.log(`[eval] Transcribed ${progress.counts.completed}/${progress.counts.expected} chunks; queue ${JSON.stringify(worker.status)}`);
        check();
      };
      const onChunkFailed = (start: number, error: Error) => {
        chunkFailures.push(`audio at ${start.toFixed(1)}s: ${error.message}`);
        progress.finishChunk(); armWatchdog();
        if (progress.counts.completed % 10 === 0) console.log(`[eval] Finished ${progress.counts.completed}/${progress.counts.expected} chunks (${chunkFailures.length} failed); queue ${JSON.stringify(worker.status)}`);
        check();
      };
      const onEnd = (code: number) => { if (code !== 0) { finish(new Error(`Replay source ended with code ${code}`)); return; } progress.end(); check(); };
      const onError = (error: Error) => finish(error);
      worker.on("chunkTranscribed", onChunkFinished); worker.on("chunkFailed", onChunkFailed);
      source.on("chunk", onChunk); source.on("end", onEnd); source.on("error", onError);
      armWatchdog();
      void source.start().catch(finish);
    });
    if (chunkFailures.length) throw new Error(`Transcription failed for ${chunkFailures.length} chunk(s): ${chunkFailures.join("; ")}`);
    const elapsedSeconds = (performance.now() - startedAt) / 1000;
    meanRtf = transcribeRtfs.length ? transcribeRtfs.reduce((sum, value) => sum + value, 0) / transcribeRtfs.length : 0;
    const sortedRtfs = [...transcribeRtfs].sort((a, b) => a - b);
    maxRtf = sortedRtfs.at(-1) ?? 0;
    p95Rtf = sortedRtfs[Math.min(sortedRtfs.length - 1, Math.ceil(sortedRtfs.length * 0.95) - 1)] ?? 0;
    await source.stop(); activeSource = undefined;
    await writeFile(cachePath, JSON.stringify({ version: 2, sourceBytes: sourceStats.size, sourceMtimeMs: sourceStats.mtimeMs,
      asrModel, device, meanRtf, maxRtf, p95Rtf, transcript } satisfies TranscriptCache));
  }

  const vectors = new Map<string, { vector: number[]; latency: number }>();
  for (const claim of evaluationClaims) {
    const started = performance.now();
    vectors.set(claim.id, { vector: await worker.embed(claim.claim), latency: performance.now() - started });
  }
  const runTrial = (claim: Claim, thresholds: Thresholds): Trial => {
    const cached = vectors.get(claim.id)!; const started = performance.now();
    const result = decide(claim.claim, transcript, "eval", randomUUID(), cached.vector, thresholds);
    return { outcome: result.outcome, score: result.score, latency: cached.latency + performance.now() - started };
  };
  const grid: Thresholds[] = [];
  for (let found = 0.45; found <= 0.8501; found += 0.05)
    for (let miss = 0.10; miss <= Math.min(0.40, found - 0.1); miss += 0.05) grid.push({ found: Number(found.toFixed(2)), miss: Number(miss.toFixed(2)) });
  let chosen: Thresholds = { found: 0.62, miss: 0.28 }, bestCorrect = -1;
  for (const thresholds of grid) {
    const trials = tune.map(claim => runTrial(claim, thresholds));
    const falseFound = trials.filter((trial, index) => tune[index]!.expected === "NO MATCH" && trial.outcome === "RECEIPT FOUND").length;
    const correct = trials.filter((trial, index) => trial.outcome === tune[index]!.expected).length;
    if (falseFound === 0 && correct > bestCorrect) { chosen = thresholds; bestCorrect = correct; }
  }
  const tuneTrials = tune.map(claim => runTrial(claim, chosen)), heldTrials = held.map(claim => runTrial(claim, chosen));
  const allTrials = [...tuneTrials, ...heldTrials];

  const referenceText = await readFile(referencePath, "utf8");
  const chapterStarts = [...referenceText.matchAll(/\n\s*CHAPTER I\.\s*/gi)];
  const firstChapter = chapterStarts.length > 1 ? chapterStarts[1]!.index! : -1;
  const nextChapter = referenceText.indexOf("CHAPTER II.", firstChapter + 10);
  const tokens = (text: string) => text.toLowerCase().replace(/[^a-z0-9']+/g, " ").trim().split(/\s+/).filter(Boolean);
  const referenceTokens = tokens(referenceText.slice(firstChapter, nextChapter));
  const transcriptTokens = tokens(transcript.map(row => row.text).join(" "));
  let previous = Array.from({ length: transcriptTokens.length + 1 }, (_, index) => index);
  for (let i = 1; i <= referenceTokens.length; i++) {
    const row = [i];
    for (let j = 1; j <= transcriptTokens.length; j++) row[j] = Math.min(row[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + (referenceTokens[i - 1] === transcriptTokens[j - 1] ? 0 : 1));
    previous = row;
  }
  const wer = referenceTokens.length ? previous[transcriptTokens.length]! / referenceTokens.length : NaN;
  const counts = (trials: Trial[]) => Object.fromEntries(["RECEIPT FOUND", "NO MATCH", "CAN'T TELL"].map(outcome => [outcome, trials.filter(trial => trial.outcome === outcome).length]));
  const heldCounts = counts(heldTrials), overallCounts = counts(allTrials);
  const heldWrongFound = heldTrials.filter((trial, index) => held[index]!.expected === "NO MATCH" && trial.outcome === "RECEIPT FOUND").length;
  const overallCorrect = allTrials.filter((trial, index) => trial.outcome === evaluationClaims[index]!.expected).length;
  const latencies = allTrials.map(trial => trial.latency).sort((a, b) => a - b);
  const meanLatency = allTrials.reduce((sum, trial) => sum + trial.latency, 0) / allTrials.length;
  const p95 = latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)] ?? 0;
  const heldRows = held.map((claim, index) => `| ${claim.id} | ${claim.claim.replaceAll("|", "\\|")} | ${claim.expected} | ${heldTrials[index]!.outcome} | ${heldTrials[index]!.score.toFixed(4)} |`).join("\n");
  const targetMet = heldWrongFound === 0 && overallCorrect >= 21;
  const replayMode = cacheUsed ? "skipped; validated cached transcript reused" : fast ? "accelerated eval-only (--fast); same PCM chunks and transcript path" : "real time (default)";
  const report = `# Evaluation results\n\nRun date: ${new Date().toISOString()}\n\n## Status: COMPLETE\n\n- Replay mode: ${replayMode}.\n- Transcript cache used: ${cacheUsed ? "yes" : "no; this run wrote data/eval-transcript-cache.json"}.\n- ASR: ${device}; model ${asrModel}; transcript utterances ${transcript.length}; chunk RTF mean ${meanRtf.toFixed(3)}, p95 ${p95Rtf.toFixed(3)}, max ${maxRtf.toFixed(3)} (below 1.0 keeps pace).\n- Thresholds chosen on tune half only: found ${chosen.found.toFixed(2)}, miss ${chosen.miss.toFixed(2)}; tune correct ${bestCorrect}/15 with zero tune false FOUND.\n\n## Held-out results (n=15)\n\n- Outcome counts: RECEIPT FOUND ${heldCounts["RECEIPT FOUND"]}, NO MATCH ${heldCounts["NO MATCH"]}, CAN'T TELL ${heldCounts["CAN'T TELL"]}.\n- All-30 outcome counts: RECEIPT FOUND ${overallCounts["RECEIPT FOUND"]}, NO MATCH ${overallCounts["NO MATCH"]}, CAN'T TELL ${overallCounts["CAN'T TELL"]}.\n- Correct overall: ${overallCorrect}/30; wrong held-out RECEIPT FOUND: ${heldWrongFound}.\n- WER: ${(wer * 100).toFixed(2)}% (${previous[transcriptTokens.length]} edits / ${referenceTokens.length} reference words).\n- Claim-to-decision latency: mean ${meanLatency.toFixed(1)} ms; p95 ${p95.toFixed(1)} ms.\n- Target (zero wrong held-out FOUND and at least 21/30 correct): ${targetMet ? "MET" : "NOT MET"}.\n\n## Held-out claims\n\n| ID | Claim | Expected | Actual | Score |\n|---|---|---|---|---:|\n${heldRows}\n`;
  await writeFile(resultPath, report, "utf8");
  worker.stop(); activeWorker = undefined;
  console.log(report);
}

main().catch(async error => {
  await activeSource?.stop().catch(() => undefined);
  activeWorker?.stop(); activeWorker = undefined;
  const reason = `Evaluation failed: ${(error as Error).message}`;
  await writeBlocked(reason);
  console.error(reason);
  process.exitCode = 1;
});
