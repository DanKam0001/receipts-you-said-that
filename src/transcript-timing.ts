import type { Utterance, WordTiming } from "./model.js";

export interface TimedSentence { text: string; start: number; end: number; words: WordTiming[]; }

/** Use Whisper word times when present; old caches get even word-proportional estimates. */
export function timedWords(rows: Utterance[]): WordTiming[] {
  return rows.flatMap(row => {
    const tokens = row.text.match(/\S+/g) ?? [];
    if (!tokens.length) return [];
    const actual = row.words;
    if (actual?.length === tokens.length && actual.every(word => Number.isFinite(word.start) && Number.isFinite(word.end) && word.end >= word.start)) {
      return tokens.map((text, index) => ({ text, start: actual[index]!.start, end: actual[index]!.end, estimated: actual[index]!.estimated }));
    }
    const duration = Math.max(0, row.end - row.start);
    return tokens.map((text, index) => ({ text, start: row.start + duration * index / tokens.length,
      end: row.start + duration * (index + 1) / tokens.length, estimated: true }));
  });
}

/** Split utterances into exact transcript sentences while retaining word timing spans. */
export function timedSentences(rows: Utterance[]): TimedSentence[] {
  const pieces: Array<{ row: Utterance; offset: number; text: string }> = [];
  let joined = "";
  for (const row of rows) {
    if (joined) joined += " ";
    pieces.push({ row, offset: joined.length, text: row.text });
    joined += row.text;
  }
  const tokens: Array<{ text: string; start: number; end: number; time: WordTiming }> = [];
  for (const piece of pieces) {
    const rowsWords = timedWords([piece.row]);
    const matches = [...piece.text.matchAll(/\S+/g)];
    matches.forEach((match, index) => {
      const time = rowsWords[index]!;
      tokens.push({ text: match[0], start: piece.offset + match.index!, end: piece.offset + match.index! + match[0].length, time });
    });
  }
  const sentences: TimedSentence[] = [];
  const expression = /[^.!?]+(?:[.!?]+|$)/g;
  for (const match of joined.matchAll(expression)) {
    const raw = match[0]!, startOffset = match.index!, endOffset = startOffset + raw.length;
    const included = tokens.filter(token => token.start >= startOffset && token.start < endOffset);
    if (!included.length) continue;
    const words = included.map(token => token.time);
    sentences.push({ text: raw.trim(), start: words[0]!.start, end: words.at(-1)!.end, words });
  }
  return sentences;
}
