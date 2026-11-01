import type { Receipt, Utterance } from "./model.js";

export interface DecisionThresholds { entailment: number; contradiction: number; negationGuardEntailment: number; onTopicRetrieval: number; }
export const DEFAULT_THRESHOLDS: DecisionThresholds = { entailment: 0.78, contradiction: 0.72, negationGuardEntailment: 0.975, onTopicRetrieval: 0.30 };
const stop = new Set("a an the and or but if then than to of in on at for from with by as is was were be been being am are do does did have has had it this that i you he she they we me my your his her their our would could should will can may might honestly really stuff thing said say claim".split(" "));
const negations = new Set(["not", "never", "no", "without", "neither", "nor", "cannot", "cant", "can't", "dont", "don't", "didnt", "didn't", "wont", "won't", "isnt", "isn't", "wasnt", "wasn't", "hardly", "nobody", "nothing", "nowhere"]);
const normalize = (text: string) => text.toLowerCase().replace(/\u2019/g, "'").replace(/n['\u2019]t\b/g, " not");
const words = (text: string) => normalize(text).match(/[a-z0-9']+/g)?.filter(w => w.length > 1 && !stop.has(w)) ?? [];

/** Remove viewer attribution wrappers so NLI sees the proposition itself. */
export function normalizeClaimForNli(claim: string): string {
  return claim.trim()
    .replace(/^(?:(?:you|he|she|the streamer|streamer|they)\s+(?:said|claimed|mentioned|told us)\s+(?:that\s+)?|(?:you|he|she|the streamer|streamer|they)\s+were saying\s+(?:that\s+)?)+/i, "")
    .replace(/^(?:quote\s*:\s*)/i, "").trim();
}

function editSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(row[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return Math.max(0, 1 - prev[b.length]! / Math.max(a.length, b.length));
}

function lexicalSimilarity(query: string, candidate: string): number {
  const q = words(query), c = words(candidate);
  if (!q.length || !c.length) return 0;
  return q.reduce((sum, token) => sum + Math.max(...c.map(other => editSimilarity(token, other))), 0) / q.length;
}

function cosine(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; aa += a[i]! * a[i]!; bb += b[i]! * b[i]!; }
  return aa && bb ? Math.max(0, Math.min(1, dot / Math.sqrt(aa * bb))) : 0;
}

function averageEmbedding(rows: Utterance[]): number[] | undefined {
  const vectors = rows.map(row => row.embedding).filter((vector): vector is number[] => !!vector?.length);
  if (!vectors.length || vectors.some(vector => vector.length !== vectors[0]!.length)) return undefined;
  const result = Array(vectors[0]!.length).fill(0) as number[];
  for (const vector of vectors) for (let i = 0; i < result.length; i++) result[i]! += vector[i]! / vectors.length;
  return result;
}

function negationConflict(claim: string, candidate: string): boolean {
  const q = new Set(normalize(claim).match(/[a-z']+/g) ?? []), c = new Set(normalize(candidate).match(/[a-z']+/g) ?? []);
  if ((q.has("never") && c.has("always")) || (q.has("always") && c.has("never"))) return true;
  const qNeg = [...q].filter(word => negations.has(word)).length % 2 === 1;
  const cNeg = [...c].filter(word => negations.has(word)).length % 2 === 1;
  return qNeg !== cNeg;
}

export interface Candidate {
  id: string;
  startIndex: number;
  utteranceCount: number;
  premise: string;
  retrievalScore: number;
  lexicalScore: number;
  semanticScore: number;
  quote: string;
  timestamp: number;
  quoteEnd: number;
  context: string;
  clipStart: number;
  clipEnd: number;
  negationConflict: boolean;
}
export interface NliProbabilities { contradiction: number; entailment: number; neutral: number; }
export interface ScoredCandidate extends Candidate { probabilities: NliProbabilities; }

/** Hybrid lexical/vector retrieval over every contiguous one-, two-, and three-utterance window. */
export function retrieve(query: string, transcript: Utterance[], queryEmbedding: number[], limit = 8): Candidate[] {
  const proposition = normalizeClaimForNli(query);
  const candidates: Candidate[] = [];
  for (let start = 0; start < transcript.length; start++) {
    for (const size of [1, 2, 3]) {
      const rows = transcript.slice(start, start + size);
      if (rows.length !== size) continue;
      const premise = rows.map(row => row.text.trim()).filter(Boolean).join(" ");
      if (!premise) continue;
      const lexical = lexicalSimilarity(proposition, premise);
      const vector = averageEmbedding(rows);
      const semantic = vector ? cosine(queryEmbedding, vector) : 0;
      const retrievalScore = 0.62 * semantic + 0.38 * lexical;
      const before = transcript[start - 1], after = transcript[start + size];
      candidates.push({
        id: `u${start + 1}-${start + size}`,
        startIndex: start,
        utteranceCount: size,
        premise,
        retrievalScore,
        lexicalScore: lexical,
        semanticScore: semantic,
        quote: premise,
        timestamp: rows[0]!.start,
        quoteEnd: rows.at(-1)!.end,
        context: [before?.text, after?.text].filter(Boolean).join(" … "),
        clipStart: Math.max(0, before?.start ?? rows[0]!.start),
        clipEnd: after?.end ?? rows.at(-1)!.end,
        negationConflict: negationConflict(proposition, premise)
      });
    }
  }
  const ranked = candidates.sort((a, b) => b.retrievalScore - a.retrievalScore);
  const selected = [1, 2, 3].map(size => ranked.find(candidate => candidate.utteranceCount === size)).filter((candidate): candidate is Candidate => !!candidate);
  for (const candidate of ranked) {
    if (selected.length >= limit) break;
    if (!selected.some(existing => existing.id === candidate.id)) selected.push(candidate);
  }
  return selected.sort((a, b) => b.retrievalScore - a.retrievalScore).slice(0, limit);
}

export function decideVerified(
  query: string, candidates: Candidate[], probabilities: NliProbabilities[], requester: string,
  id: string = crypto.randomUUID(), thresholds: DecisionThresholds = DEFAULT_THRESHOLDS
): Receipt {
  const base = { id, query, requester };
  if (!words(normalizeClaimForNli(query)).length) return { ...base, outcome: "CAN'T TELL", status: "pending", score: 0, reason: "Claim has no comparable words" };
  if (!candidates.length) return { ...base, outcome: "NO MATCH", status: "pending", score: 0, reason: "No transcript window retrieved" };
  const scored = candidates.map((candidate, index) => ({ ...candidate, probabilities: probabilities[index] ?? { contradiction: 0, entailment: 0, neutral: 1 } }));
  const best = [...scored].sort((a, b) => b.probabilities.entailment - a.probabilities.entailment || b.retrievalScore - a.retrievalScore)[0]!;
  const score = Number(best.probabilities.entailment.toFixed(4));
  const record = { candidateId: best.id, retrievalScore: Number(best.retrievalScore.toFixed(4)) };
  if (scored.every(candidate => candidate.retrievalScore < 0.05))
    return { ...base, ...record, outcome: "NO MATCH", status: "pending", score, reason: "No candidate window retrieved" };

  // A found decision requires both entailment and low contradiction on the same window.
  const negationVeto = best.negationConflict && best.probabilities.entailment < thresholds.negationGuardEntailment;
  if (best.probabilities.entailment >= thresholds.entailment && best.probabilities.contradiction <= thresholds.contradiction && !negationVeto) {
    return { ...base, ...record, outcome: "RECEIPT FOUND", status: "pending", score,
      quote: best.quote, timestamp: best.timestamp, context: best.context,
      quoteEnd: best.quoteEnd, clipStart: best.clipStart, clipEnd: best.clipEnd };
  }

  const clearContradiction = [...scored].filter(candidate => candidate.retrievalScore >= thresholds.onTopicRetrieval
      && (candidate.lexicalScore >= 0.15 || candidate.semanticScore >= 0.65)
      && candidate.probabilities.contradiction >= thresholds.contradiction
      && candidate.probabilities.contradiction > candidate.probabilities.neutral)
    .sort((a, b) => b.probabilities.contradiction - a.probabilities.contradiction)[0];
  if (clearContradiction) return { ...base, candidateId: clearContradiction.id, retrievalScore: Number(clearContradiction.retrievalScore.toFixed(4)),
    outcome: "NO MATCH", status: "pending", score: Number(clearContradiction.probabilities.entailment.toFixed(4)), reason: "Retrieved window clearly contradicts the claim" };
  return { ...base, ...record, outcome: "CAN'T TELL", status: "pending", score,
    reason: negationVeto ? "Negation guard vetoed a low-entailment candidate" : "NLI verification was inconclusive or retrieval was off-topic" };
}
