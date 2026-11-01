import type { Outcome, Receipt, Utterance } from "./model.js";

const words = (text: string) => new Set((text.toLowerCase().match(/[a-z0-9']+/g) ?? []).filter(w => w.length > 1));

export function decide(query: string, transcript: Utterance[], requester: string, id: string = crypto.randomUUID()): Receipt {
  const q = words(query);
  if (!q.size) return { id, outcome: "CAN'T TELL", query, requester, status: "pending", reason: "Claim is too short to compare" };
  const sentences = transcript.flatMap((u, utteranceIndex) => {
    const parts = u.text.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [u.text];
    return parts.map(text => ({ text: text.trim(), utteranceIndex, source: u })).filter(s => s.text);
  });
  const scored = sentences.map((sentence, i) => {
    const tw = words(sentence.text), overlap = [...q].filter(w => tw.has(w)).length;
    return { sentence, i, score: overlap / q.size, overlap };
  }).sort((a, b) => b.score - a.score);
  const best = scored[0];
  const contentWords = transcript.reduce((n, u) => n + words(u.text).size, 0);
  const reliableTranscript = transcript.length >= 4 && contentWords >= 24 && transcript.every(u => (u.confidence ?? 1) >= 0.5);
  if (!best || best.overlap === 0) return reliableTranscript
    ? { id, outcome: "NO MATCH", query, requester, status: "pending" }
    : { id, outcome: "CAN'T TELL", query, requester, status: "pending", reason: "Not enough reliable transcript to confirm a miss" };
  if (best.score < 0.6 || (scored[1] && scored[1].score >= best.score - 0.15) || (best.sentence.source.confidence ?? 1) < 0.5)
    return { id, outcome: "CAN'T TELL", query, requester, status: "pending", reason: "Transcript match is ambiguous" };
  const target = best.sentence, before = sentences[best.i - 1], after = sentences[best.i + 1];
  if (!before || !after) return { id, outcome: "CAN'T TELL", query, requester, status: "pending", reason: "Not enough surrounding transcript context" };
  return { id, outcome: "RECEIPT FOUND", query, quote: target.text, timestamp: target.source.start,
    context: `${before.text} … ${after.text}`,
    clipStart: Math.max(0, before.source.start), clipEnd: after.source.end,
    requester, status: "pending" };
}

export function decideWithConfidence(query: string, transcript: Utterance[], requester: string): Outcome {
  return decide(query, transcript, requester).outcome;
}
