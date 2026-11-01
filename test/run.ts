import assert from "node:assert/strict";
import { resetReplaySession, RollingAudioBuffer } from "../src/audio.js";
import { decideVerified, normalizeClaimForNli, retrieve, type Candidate, type NliProbabilities } from "../src/matcher.js";
import type { Utterance } from "../src/model.js";
import { fitQuote, receiptCountLabel } from "../src/overlay-layout.js";
import { ANNOUNCER_FILES, announcerForOutcome, hallOfShameReply, maySettle, replayCooldownRemaining, replayReceiptPosition, selectReplayReceipt } from "../src/show-control.js";

let count = 0;
function test(name: string, body: () => void) { body(); count++; console.log(`ok ${count} - ${name}`); }
const p = (entailment: number, contradiction: number, neutral = 1 - entailment - contradiction): NliProbabilities => ({ entailment, contradiction, neutral });
const base: Candidate = { id: "u2-2", startIndex: 1, utteranceCount: 1, premise: "I wondered how many miles I had fallen.", retrievalScore: 0.82, lexicalScore: 0.42, semanticScore: 0.9,
  quote: "I wondered how many miles I've fallen.", timestamp: 12, quoteEnd: 14, context: "It was a curious fall. … The ground seemed far away.", clipStart: 10, clipEnd: 17, negationConflict: false,
  utterances: [{ start: 12, end: 14, text: "I wondered how many miles I've fallen." }], quoteWords: [] };

test("viewer attribution is stripped before verification for first-person transcript wording", () => {
  assert.equal(normalizeClaimForNli("you said that Alice wondered how far she'd fallen"), "Alice wondered how far she'd fallen");
  assert.equal(normalizeClaimForNli("the streamer claimed she was late"), "she was late");
});

test("overlay receipt count is singular only for one", () => {
  assert.equal(receiptCountLabel(1), "1 RECEIPT");
  assert.equal(receiptCountLabel(2), "2 RECEIPTS");
});

test("overlay quote fitting stays at least 44px, within three lines, and retains active words", () => {
  const source = Array.from({ length: 90 }, (_, index) => `word${index}`).join(" ");
  const fit = fitQuote(source, 900, 68);
  assert.equal(fit.fontSize, 44);
  assert.equal(fit.truncated, true);
  assert.ok(fit.startWord <= 68 && fit.endWord > 68);
  assert.match(fit.text, /^… /);
  assert.match(fit.text, / …$/);
});

test("announcer choices map outcomes to the six fixed files", () => {
  assert.deepEqual([...ANNOUNCER_FILES], ["found.mp3", "nomatch.mp3", "canttell.mp3", "vetoed.mp3", "played.mp3", "replay.mp3"]);
  assert.equal(announcerForOutcome("RECEIPT FOUND"), "found.mp3");
  assert.equal(announcerForOutcome("NO MATCH"), "nomatch.mp3");
  assert.equal(announcerForOutcome("CAN'T TELL"), "canttell.mp3");
});

test("hall of shame replay selection rejects pending and vetoed receipts", () => {
  const rows = [{ id: "pending", status: "pending" }, { id: "vetoed", status: "vetoed" }, { id: "old", status: "played" }, { id: "new", status: "played" }] as const;
  assert.equal(selectReplayReceipt(rows)?.id, "new");
  assert.equal(selectReplayReceipt(rows, 1)?.id, "old");
  assert.equal(selectReplayReceipt(rows, 3), undefined);
});

test("hall of shame chat reply uses the current-session receipt position, never an ID", () => {
  const played = [{ status: "played" }, { status: "played" }] as const;
  assert.equal(replayReceiptPosition(played, played[0]), 1);
  assert.equal(hallOfShameReply(1), "Hall of shame, receipt 1.");
  assert.doesNotMatch(hallOfShameReply(1), /[0-9a-f]{8}-[0-9a-f-]{27}/i);
});

test("hall of shame replay cooldown reports remaining time", () => {
  assert.equal(replayCooldownRemaining(undefined, 100_000, 60), 0);
  assert.equal(replayCooldownRemaining(100_000, 130_000, 60), 30);
  assert.equal(replayCooldownRemaining(100_000, 160_000, 60), 0);
});

test("settling an on-record quote is moderator and broadcaster only", () => {
  assert.equal(maySettle(false, false), false);
  assert.equal(maySettle(true, false), true);
  assert.equal(maySettle(false, true), true);
});

test("starting file replay clears the rolling audio buffer and transcript", () => {
  const ring = new RollingAudioBuffer(10); ring.push({ start: 0, end: 2, pcm: Buffer.alloc(64000) });
  const transcript: Utterance[] = [{ start: 0, end: 2, text: "old session" }];
  resetReplaySession(ring, transcript);
  assert.equal(ring.bufferedSeconds, 0); assert.equal(ring.clip(0, 1), undefined); assert.equal(transcript.length, 0);
});

test("retrieval includes adjacent windows of one, two, and three utterances, capped at eight", () => {
  const transcript: Utterance[] = Array.from({ length: 5 }, (_, index) => ({ start: index * 2, end: index * 2 + 2, text: `Sentence ${index} about falling and Alice.`, embedding: [1, 0] }));
  const top = retrieve("you said Alice was falling", transcript, [1, 0]);
  assert.equal(top.length, 8);
  assert.ok(top.some(candidate => candidate.utteranceCount === 1));
  assert.ok(top.some(candidate => candidate.utteranceCount === 2));
  assert.ok(top.some(candidate => candidate.utteranceCount === 3));
});

test("high entailment and low contradiction on one candidate produces a verbatim receipt", () => {
  const result = decideVerified("you said Alice wondered how far she'd fallen", [base], [p(0.93, 0.02)], "viewer", "receipt-1");
  assert.equal(result.outcome, "RECEIPT FOUND");
  assert.equal(result.quote, base.quote);
  assert.equal(result.score, 0.93);
  assert.equal(result.candidateId, base.id);
  assert.equal(result.timestamp, 12); assert.equal(result.clipStart, 10); assert.equal(result.clipEnd, 17);
});

test("a clearly contradicting retrieved window yields NO MATCH with its entailment score", () => {
  const result = decideVerified("you said Alice ate the marmalade", [base], [p(0.03, 0.91)], "viewer", "receipt-2");
  assert.equal(result.outcome, "NO MATCH");
  assert.equal(result.score, 0.03);
  assert.equal(result.candidateId, base.id);
});

test("middle confidence returns CAN'T TELL; high entailment can override the negation guard but low entailment cannot", () => {
  assert.equal(decideVerified("you said Alice was late", [base], [p(0.55, 0.12)], "viewer").outcome, "CAN'T TELL");
  const conflict = { ...base, premise: "I'll always play this.", negationConflict: true };
  assert.equal(decideVerified("you said you'd never play this", [conflict], [p(0.988, 0.01)], "viewer").outcome, "RECEIPT FOUND");
  assert.equal(decideVerified("you said you'd never play this", [conflict], [p(0.84, 0.03)], "viewer").outcome, "CAN'T TELL");
});

test("NO MATCH requires an on-topic NLI contradiction or no retrieved candidate; weak off-topic evidence is uncertain", () => {
  assert.equal(decideVerified("you said there was a secret", [], [], "viewer").outcome, "NO MATCH");
  assert.equal(decideVerified("!!!", [base], [p(0.9, 0.02)], "viewer").outcome, "CAN'T TELL");
  const offTopic = { ...base, retrievalScore: 0.32, lexicalScore: 0.03, semanticScore: 0.47 };
  assert.equal(decideVerified("you said secret", [offTopic], [p(0.01, 0.92, 0.07)], "viewer").outcome, "CAN'T TELL");
  const onTopicContradiction = { ...base, lexicalScore: 0.4 };
  assert.equal(decideVerified("you said Alice ate marmalade", [onTopicContradiction], [p(0.02, 0.91, 0.07)], "viewer").outcome, "NO MATCH");
  assert.equal(decideVerified("you said secret", [{ ...base, retrievalScore: 0.02 }], [p(0.01, 0.02)], "viewer").outcome, "NO MATCH");
});

test("rolling audio buffer emits a WAV cropped to the requested interval", () => {
  const ring = new RollingAudioBuffer(4); ring.push({ start: 0, end: 2, pcm: Buffer.alloc(64000, 1) });
  const clip = ring.clip(0.5, 1.5)!;
  assert.equal(clip.subarray(0, 4).toString(), "RIFF"); assert.equal(clip.readUInt32LE(40), 32000); assert.equal(clip.length, 32044);
});

test("rolling buffer expires audio outside its time window", () => {
  const ring = new RollingAudioBuffer(3);
  ring.push({ start: 0, end: 2, pcm: Buffer.alloc(64000) }); ring.push({ start: 2, end: 4, pcm: Buffer.alloc(64000) });
  assert.equal(ring.clip(0, 1), undefined);
});

console.log(`\n${count} tests passed`);
