import { existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { FfmpegPcmSource } from "../src/audio.js";
import { decideVerified, normalizeClaimForNli, retrieve, type DecisionThresholds } from "../src/matcher.js";
import type { Utterance } from "../src/model.js";
import { WhisperWorker } from "../src/transcriber.js";
import { ReplayCompletion } from "../src/replay-completion.js";

interface Claim { id: string; split: "tune" | "seen_held_out" | "fresh_held_out"; expected: "RECEIPT FOUND" | "NO MATCH"; claim: string; }
interface SyntheticClaim { id: string; expected: "RECEIPT FOUND" | "NO MATCH"; claim: string; }
interface SyntheticFixture { description: string; lines: string[]; claims: SyntheticClaim[]; }
interface Trial { outcome: string; score: number; latency: number; candidateId?: string; }
interface TranscriptCache { version: 2; sourceBytes: number; sourceMtimeMs: number; asrModel: string; device: string; meanRtf: number; maxRtf: number; p95Rtf: number; transcript: Utterance[]; }
const resultPath = resolve("eval/RESULTS.md"), sourcePath = resolve("data/replay.wav"), referencePath = resolve("data/alice_reference.txt");
const cachePath = resolve("data/eval-transcript-cache.json"), fastEmbedPath = resolve(".venv/Lib/site-packages/fastembed");
let evaluationClaims: Claim[] = [];
let activeWorker: WhisperWorker | undefined, activeSource: FfmpegPcmSource | undefined;

async function writeBlocked(reason: string) {
  if (!evaluationClaims.length && existsSync("eval/claims.json")) {
    try { evaluationClaims = JSON.parse(await readFile("eval/claims.json", "utf8")) as Claim[]; } catch { /* Preserve the primary evaluation failure. */ }
  }
  const held = evaluationClaims.filter(claim => claim.split === "fresh_held_out");
  const rows = held.map(claim => `| ${claim.id} | ${claim.claim.replaceAll("|", "\\|")} | ${claim.expected} | N/A | N/A | N/A |`).join("\n");
  const table = held.length ? `\n\n## Fresh held-out claims\n\n| ID | Claim | Expected | Actual | Entailment score | Candidate |\n|---|---|---|---|---:|---|\n${rows}` : "";
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
  const tune = evaluationClaims.filter(claim => claim.split === "tune"), seen = evaluationClaims.filter(claim => claim.split === "seen_held_out"), fresh = evaluationClaims.filter(claim => claim.split === "fresh_held_out");
  if (evaluationClaims.length !== 50 || tune.length !== 15 || seen.length !== 15 || fresh.length !== 20
      || fresh.filter(claim => claim.expected === "RECEIPT FOUND").length !== 10 || fresh.filter(claim => claim.expected === "NO MATCH").length !== 10)
    throw new Error("Expected 15 tune, 15 seen_held_out, and 20 fresh_held_out claims (10 true and 10 false)");
  const synthetic = JSON.parse(await readFile("eval/streamer_lines.json", "utf8")) as SyntheticFixture;
  if (synthetic.lines.length !== 40 || synthetic.claims.length !== 16 || synthetic.claims.filter(claim => claim.expected === "RECEIPT FOUND").length !== 8 || synthetic.claims.filter(claim => claim.expected === "NO MATCH").length !== 8)
    throw new Error("Synthetic streamer fixture must have 40 lines and 16 claims split 8/8");

  const sourceStats = await stat(sourcePath), asrModel = process.env.RECEIPTS_ASR_MODEL ?? "small.en";
  const fast = process.argv.includes("--fast");
  let transcript: Utterance[] = [], cacheUsed = false, device = "unknown", meanRtf = 0, maxRtf = 0, p95Rtf = 0;
  if (existsSync(cachePath)) {
    const cached = JSON.parse(await readFile(cachePath, "utf8")) as TranscriptCache;
    if (cached.version === 2 && cached.sourceBytes === sourceStats.size && cached.sourceMtimeMs === sourceStats.mtimeMs && cached.asrModel === asrModel) {
      transcript = cached.transcript; cacheUsed = true; device = cached.device; meanRtf = cached.meanRtf; maxRtf = cached.maxRtf; p95Rtf = cached.p95Rtf;
    }
  }

  process.env.RECEIPTS_SKIP_ASR = cacheUsed ? "1" : "0";
  const worker = new WhisperWorker(); activeWorker = worker;
  const transcribeRtfs: number[] = [], chunkFailures: string[] = [];
  worker.on("transcript", (rows: Utterance[]) => transcript.push(...rows));
  worker.on("chunkTranscribed", (_start: number, _elapsedMs?: number, rtf?: number) => { if (rtf !== undefined) transcribeRtfs.push(rtf); });
  worker.on("chunkFailed", (start: number, error: Error) => chunkFailures.push(`audio at ${start.toFixed(1)}s: ${error.message}`));
  worker.on("log", message => console.log(`[ASR] ${message}`));
  worker.on("error", error => console.error(`[ASR] ${error.message}`));
  worker.start();
  await waitForReady(worker);
  if (worker.status.device && worker.status.device !== "asr-skipped") device = worker.status.device;

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

  const prepared = new Map<string, { candidates: ReturnType<typeof retrieve>; probabilities: Awaited<ReturnType<typeof worker.verify>>; latency: number }>();
  let verificationPairTimeMs = 0, verificationPairCount = 0;
  worker.on("verificationLatency", (_totalMs: number, meanPairMs: number, pairCount: number) => {
    if (Number.isFinite(meanPairMs) && Number.isFinite(pairCount)) { verificationPairTimeMs += meanPairMs * pairCount; verificationPairCount += pairCount; }
  });
  for (const claim of evaluationClaims) {
    const started = performance.now();
    const proposition = normalizeClaimForNli(claim.claim);
    const vector = await worker.embed(proposition);
    const candidates = retrieve(claim.claim, transcript, vector, 8);
    const probabilities = await worker.verify(candidates.map(candidate => ({ premise: candidate.premise, hypothesis: proposition })));
    prepared.set(claim.id, { candidates, probabilities, latency: performance.now() - started });
  }
  const runTrial = (claim: Claim, thresholds: DecisionThresholds): Trial => {
    const cached = prepared.get(claim.id)!; const started = performance.now();
    const result = decideVerified(claim.claim, cached.candidates, cached.probabilities, "eval", randomUUID(), thresholds);
    return { outcome: result.outcome, score: result.score, latency: cached.latency + performance.now() - started, candidateId: result.candidateId };
  };
  const grid: DecisionThresholds[] = [];
  for (let entailment = 0.55; entailment <= 0.9501; entailment += 0.05)
    for (let contradiction = 0.35; contradiction <= 0.8001; contradiction += 0.05)
      for (const negationGuardEntailment of [0.80, 0.85, 0.90, 0.925, 0.95, 0.975])
        for (const onTopicRetrieval of [0.18, 0.25, 0.32, 0.40, 0.50])
          grid.push({ entailment: Number(entailment.toFixed(2)), contradiction: Number(contradiction.toFixed(2)), negationGuardEntailment, onTopicRetrieval });
  let chosen: DecisionThresholds = { entailment: 0.78, contradiction: 0.72, negationGuardEntailment: 0.975, onTopicRetrieval: 0.30 }, bestCorrect = -1;
  for (const thresholds of grid) {
    const trials = tune.map(claim => runTrial(claim, thresholds));
    const falseFound = trials.filter((trial, index) => tune[index]!.expected === "NO MATCH" && trial.outcome === "RECEIPT FOUND").length;
    const correct = trials.filter((trial, index) => trial.outcome === tune[index]!.expected).length;
    if (falseFound === 0 && correct > bestCorrect) { chosen = thresholds; bestCorrect = correct; }
  }
  const tuneTrials = tune.map(claim => runTrial(claim, chosen)), seenTrials = seen.map(claim => runTrial(claim, chosen)), freshTrials = fresh.map(claim => runTrial(claim, chosen));

  // Synthetic first-person text uses the same embeddings, retrieval, NLI, and decision function; it never goes through audio or Whisper.
  const syntheticTranscript: Utterance[] = [];
  for (let index = 0; index < synthetic.lines.length; index++) {
    const text = synthetic.lines[index]!;
    syntheticTranscript.push({ start: index * 5, end: index * 5 + 4, text, embedding: await worker.embed(text) });
  }
  const syntheticTrials: Trial[] = [];
  for (const claim of synthetic.claims) {
    const proposition = normalizeClaimForNli(claim.claim);
    const vector = await worker.embed(proposition);
    const candidates = retrieve(claim.claim, syntheticTranscript, vector, 8);
    const probabilities = await worker.verify(candidates.map(candidate => ({ premise: candidate.premise, hypothesis: proposition })));
    const result = decideVerified(claim.claim, candidates, probabilities, "synthetic-eval", claim.id, chosen);
    syntheticTrials.push({ outcome: result.outcome, score: result.score, latency: 0, candidateId: result.candidateId });
  }

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
  const freshCounts = counts(freshTrials), seenCounts = counts(seenTrials), syntheticCounts = counts(syntheticTrials);
  const syntheticCorrect = syntheticTrials.filter((trial, index) => trial.outcome === synthetic.claims[index]!.expected).length;
  const freshWrongFound = freshTrials.filter((trial, index) => fresh[index]!.expected === "NO MATCH" && trial.outcome === "RECEIPT FOUND").length;
  const freshCorrect = freshTrials.filter((trial, index) => trial.outcome === fresh[index]!.expected).length;
  const freshLatencies = freshTrials.map(trial => trial.latency).sort((a, b) => a - b);
  const meanLatency = freshTrials.reduce((sum, trial) => sum + trial.latency, 0) / freshTrials.length;
  const latencyP95 = freshLatencies[Math.min(freshLatencies.length - 1, Math.ceil(freshLatencies.length * 0.95) - 1)] ?? 0;
  const freshRows = fresh.map((claim, index) => `| ${claim.id} | ${claim.claim.replaceAll("|", "\\|")} | ${claim.expected} | ${freshTrials[index]!.outcome} | ${freshTrials[index]!.score.toFixed(4)} | ${freshTrials[index]!.candidateId ?? "none"} |`).join("\n");
  const seenRows = seen.map((claim, index) => `| ${claim.id} | ${claim.expected} | ${seenTrials[index]!.outcome} | ${seenTrials[index]!.score.toFixed(4)} |`).join("\n");
  const syntheticRows = synthetic.claims.map((claim, index) => `| ${claim.id} | ${claim.claim.replaceAll("|", "\\|")} | ${claim.expected} | ${syntheticTrials[index]!.outcome} | ${syntheticTrials[index]!.score.toFixed(4)} | ${syntheticTrials[index]!.candidateId ?? "none"} |`).join("\n");
  const targetMet = freshWrongFound === 0 && freshCorrect >= 14;
  const meanPairLatency = verificationPairCount ? verificationPairTimeMs / verificationPairCount : 0;
  if (bestCorrect >= 0) await writeFile("data/nli-thresholds.json", JSON.stringify({ ...chosen, selectedOn: "tune" }, null, 2), "utf8");
  const replayMode = cacheUsed ? "skipped; validated cached transcript reused" : fast ? "accelerated eval-only (--fast); same PCM chunks and transcript path" : "real time (default)";
  const report = `# Evaluation results\n\nRun date: ${new Date().toISOString()}\n\n## Status: COMPLETE\n\nFresh held-out claims were written before this revised verifier was run. The prior held-out set has been seen and is reported only as a secondary historical set; thresholds are tuned only on the tune set.\n\n- Replay mode: ${replayMode}.\n- Transcript cache used: ${cacheUsed ? "yes" : "no; this run wrote data/eval-transcript-cache.json"}.\n- ASR: ${device}; model ${asrModel}; transcript utterances ${transcript.length}; chunk RTF mean ${meanRtf.toFixed(3)}, p95 ${p95Rtf.toFixed(3)}, max ${maxRtf.toFixed(3)} (below 1.0 keeps pace).\n- Local verifier: Xenova/nli-deberta-v3-small, CPU; each query retrieved up to 8 hybrid-ranked transcript windows of 1-3 adjacent utterances, then verified premise/hypothesis pairs. Mean pair inference ${meanPairLatency.toFixed(2)} ms (target smoke range 10-15 ms).\n- Tune-only thresholds: entailment ${chosen.entailment.toFixed(2)}, contradiction ${chosen.contradiction.toFixed(2)}, negation guard ${chosen.negationGuardEntailment.toFixed(3)}, on-topic retrieval ${chosen.onTopicRetrieval.toFixed(2)}; tune correct ${bestCorrect}/15 with zero false RECEIPT FOUND. ${bestCorrect >= 0 ? "Tune-only thresholds were saved to ignored data/nli-thresholds.json for the server." : "No threshold set satisfied the zero-false-FOUND constraint; no threshold file was written."}\n- NO MATCH policy: requires a retrieved on-topic contradiction or no retrieved candidate; neutral and weak off-topic windows return CAN'T TELL. This protects viewers from losing a life when transcript evidence is weak, at the cost of more uncertain outcomes.\n\n## Fresh held-out results (headline, n=20)\n\n- Outcome counts: RECEIPT FOUND ${freshCounts["RECEIPT FOUND"]}, NO MATCH ${freshCounts["NO MATCH"]}, CAN'T TELL ${freshCounts["CAN'T TELL"]}.\n- Correct outcome: ${freshCorrect}/20 (${(freshCorrect / 20 * 100).toFixed(1)}%); wrong false RECEIPT FOUND: ${freshWrongFound}.\n- WER: ${(wer * 100).toFixed(2)}% (${previous[transcriptTokens.length]} edits / ${referenceTokens.length} reference words).\n- Claim-to-decision latency: mean ${meanLatency.toFixed(1)} ms; p95 ${latencyP95.toFixed(1)} ms.\n- Target (zero wrong false FOUND and at least 14/20 correct): ${targetMet ? "MET" : "NOT MET"}.\n\n## Fresh held-out claims\n\n| ID | Claim | Expected | Actual | Entailment score | Candidate |\n|---|---|---|---|---:|---|\n${freshRows}\n\n## Synthetic text results (not speech; Whisper skipped)\n\nThis separate fixture uses the same hybrid retrieval, embeddings, NLI verifier, and chosen tune-only thresholds. No audio is present and Whisper transcription is skipped. Outcome counts: RECEIPT FOUND ${syntheticCounts["RECEIPT FOUND"]}, NO MATCH ${syntheticCounts["NO MATCH"]}, CAN'T TELL ${syntheticCounts["CAN'T TELL"]}; correct ${syntheticCorrect}/16.\n\n| ID | Viewer wording | Expected | Actual | Entailment score | Candidate |\n|---|---|---|---|---:|---|\n${syntheticRows}\n\n## Previously seen claims (secondary; not blind)\n\nOutcome counts: RECEIPT FOUND ${seenCounts["RECEIPT FOUND"]}, NO MATCH ${seenCounts["NO MATCH"]}, CAN'T TELL ${seenCounts["CAN'T TELL"]}.\n\n| ID | Expected | Actual | Entailment score |\n|---|---|---|---:|\n${seenRows}\n`;
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
