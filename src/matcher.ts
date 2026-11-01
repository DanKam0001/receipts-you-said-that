import type { Receipt, Utterance } from "./model.js";

export interface Thresholds { found: number; miss: number; }
export const DEFAULT_THRESHOLDS: Thresholds = { found: 0.62, miss: 0.28 };
const stop = new Set("a an the and or but if then than to of in on at for from with by as is was were be been being am are do does did have has had it this that i you he she they we me my your his her their our would could should will can may might honestly really stuff thing said say claim".split(" "));
const negate = new Set(["not", "never", "no", "without", "neither", "nor", "cannot", "cant", "can't", "dont", "don't", "didnt", "didn't", "wont", "won't", "isnt", "isn't", "wasnt", "wasn't", "hardly", "nobody", "nothing", "nowhere"]);
const normalize = (text: string) => text.toLowerCase().replace(/\u2019/g, "'").replace(/n['\u2019]t\b/g, " not");
const words = (text: string) => normalize(text).match(/[a-z0-9']+/g)?.filter(w => w.length > 1 && !stop.has(w)) ?? [];

function editSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return Math.max(0, 1 - prev[b.length] / Math.max(a.length, b.length));
}

function lexicalSimilarity(query: string, candidate: string): number {
  const q = words(query), c = words(candidate);
  if (!q.length || !c.length) return 0;
  return q.reduce((sum, token) => sum + Math.max(...c.map(other => editSimilarity(token, other))), 0) / q.length;
}

function cosine(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return aa && bb ? Math.max(0, Math.min(1, dot / Math.sqrt(aa * bb))) : 0;
}

function contradiction(query: string, candidate: string, lexical: number): boolean {
  const q = new Set(normalize(query).match(/[a-z']+/g) ?? []);
  const c = new Set(normalize(candidate).match(/[a-z']+/g) ?? []);
  const qNever = q.has("never") || q.has("not"); const cNever = c.has("never") || c.has("not");
  const qAlways = q.has("always"); const cAlways = c.has("always");
  if ((qNever && cAlways) || (qAlways && cNever)) return true;
  if (lexical >= 0.36) {
    const qNeg = [...q].filter(w => negate.has(w)).length % 2 === 1;
    const cNeg = [...c].filter(w => negate.has(w)).length % 2 === 1;
    if (qNeg !== cNeg) return true;
  }
  return false;
}

export function decide(
  query: string, transcript: Utterance[], requester: string, id: string = crypto.randomUUID(),
  queryEmbedding?: number[], thresholds: Thresholds = DEFAULT_THRESHOLDS
): Receipt {
  const base = { id, query, requester };
  if (!words(query).length) return { ...base, outcome: "CAN'T TELL", status: "pending", score: 0, reason: "Claim has no comparable words" };
  const sentences = transcript.flatMap(u => (u.text.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [u.text])
    .map(text => ({ text: text.trim(), source: u })).filter(s => s.text));
  if (!queryEmbedding || !sentences.length) return { ...base, outcome: "CAN'T TELL", status: "pending", score: 0, reason: "Transcript or local sentence model is not ready" };

  const scored = sentences.map((sentence, index) => {
    const lexical = lexicalSimilarity(query, sentence.text);
    const semantic = sentence.source.embedding ? cosine(queryEmbedding, sentence.source.embedding) : 0;
    const score = 0.62 * semantic + 0.38 * lexical;
    return { sentence, index, score, lexical, semantic, contradiction: contradiction(query, sentence.text, lexical) };
  }).sort((a, b) => b.score - a.score);
  const best = scored[0];
  const contentWords = transcript.reduce((n, u) => n + words(u.text).length, 0);
  const reliableTranscript = transcript.length >= 4 && contentWords >= 24 && transcript.every(u => (u.confidence ?? 1) >= 0.5);
  const score = Number(best.score.toFixed(4));
  if (best.contradiction && best.lexical >= 0.36 && reliableTranscript)
    return { ...base, outcome: "NO MATCH", status: "pending", score, reason: "Claim polarity contradicts the transcript" };
  if (best.score >= thresholds.found && !best.contradiction && (scored[1] === undefined || best.score - scored[1].score > 0.035)
      && (best.sentence.source.confidence ?? 1) >= 0.5) {
    const before = sentences[best.index - 1], after = sentences[best.index + 1];
    if (before && after) return { ...base, outcome: "RECEIPT FOUND", status: "pending", score,
      quote: best.sentence.text, timestamp: best.sentence.source.start, context: `${before.text} \u2026 ${after.text}`, 
      clipStart: Math.max(0, before.source.start), clipEnd: after.source.end };
    return { ...base, outcome: "CAN'T TELL", status: "pending", score, reason: "Not enough surrounding transcript context" };
  }
  if (best.score <= thresholds.miss && reliableTranscript)
    return { ...base, outcome: "NO MATCH", status: "pending", score };
  return { ...base, outcome: "CAN'T TELL", status: "pending", score,
    reason: best.contradiction ? "Claim polarity conflicts with the candidate sentence" : "Semantic match is uncertain" };
}
