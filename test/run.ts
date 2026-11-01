import assert from "node:assert/strict";
import { RollingAudioBuffer } from "../src/audio.js";
import { decideVerified, normalizeClaimForNli, retrieve, type Candidate, type NliProbabilities } from "../src/matcher.js";
import type { Utterance } from "../src/model.js";

let count = 0;
function test(name: string, body: () => void) { body(); count++; console.log(`ok ${count} - ${name}`); }
const p = (entailment: number, contradiction: number, neutral = 1 - entailment - contradiction): NliProbabilities => ({ entailment, contradiction, neutral });
const base: Candidate = { id: "u2-2", startIndex: 1, utteranceCount: 1, premise: "I wondered how many miles I had fallen.", retrievalScore: 0.82, lexicalScore: 0.42, semanticScore: 0.9,
  quote: "I wondered how many miles I've fallen.", timestamp: 12, quoteEnd: 14, context: "It was a curious fall. … The ground seemed far away.", clipStart: 10, clipEnd: 17, negationConflict: false };

test("viewer attribution is stripped before verification for first-person transcript wording", () => {
  assert.equal(normalizeClaimForNli("you said that Alice wondered how far she'd fallen"), "Alice wondered how far she'd fallen");
  assert.equal(normalizeClaimForNli("the streamer claimed she was late"), "she was late");
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
