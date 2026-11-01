import type { Candidate, DecisionThresholds, NliProbabilities } from "./matcher.js";
import { hasNegationConflict, normalizeClaimForNli } from "./matcher.js";
import type { Receipt, Utterance } from "./model.js";
import { timedSentences, timedWords, type TimedSentence } from "./transcript-timing.js";

export type VerifyPairs = (pairs: Array<{ premise: string; hypothesis: string }>) => Promise<NliProbabilities[]>;

function clearsFound(claim: string, span: TimedSentence, probabilities: NliProbabilities | undefined, thresholds: DecisionThresholds) {
  if (!probabilities) return false;
  const guardVeto = hasNegationConflict(claim, span.text) && probabilities.entailment < thresholds.negationGuardEntailment;
  return !guardVeto && probabilities.entailment >= thresholds.entailment && probabilities.contradiction <= thresholds.contradiction;
}

function wordBounds(words: TimedSentence["words"], fallbackStart: number, fallbackEnd: number) {
  return { start: words[0]?.start ?? fallbackStart, end: words.at(-1)?.end ?? fallbackEnd };
}

function quoteContext(all: TimedSentence[], span: TimedSentence): string {
  const before = all.filter(sentence => sentence.end <= span.start).at(-1);
  const after = all.find(sentence => sentence.start >= span.end);
  return [before?.text, after?.text].filter(Boolean).join(" … ");
}

/** Refines presentation only: caller supplies a RECEIPT FOUND, and this never changes its outcome or score. */
export async function refineFoundReceipt(
  receipt: Receipt,
  winner: Candidate,
  transcript: Utterance[],
  verify: VerifyPairs,
  thresholds: DecisionThresholds,
  maxClipSeconds = 15
): Promise<Receipt> {
  if (receipt.outcome !== "RECEIPT FOUND") return receipt;
  const windowWords = winner.quoteWords.length ? winner.quoteWords : timedWords(winner.utterances);
  const full: TimedSentence = {
    text: winner.quote,
    start: windowWords[0]?.start ?? winner.timestamp,
    end: windowWords.at(-1)?.end ?? winner.quoteEnd,
    words: windowWords
  };
  const sentences = timedSentences(winner.utterances);
  const spans: TimedSentence[] = [...sentences];
  for (let index = 0; index + 1 < sentences.length; index++) {
    const left = sentences[index]!, right = sentences[index + 1]!;
    spans.push({ text: `${left.text} ${right.text}`, start: left.start, end: right.end, words: [...left.words, ...right.words] });
  }

  if (spans.length) {
    const probs = await verify(spans.map(span => ({ premise: span.text, hypothesis: normalizeClaimForNli(receipt.query) })));
    const smaller = spans.map((span, index) => ({ span, probabilities: probs[index] }))
      .filter(item => item.span.words.length < full.words.length && clearsFound(receipt.query, item.span, item.probabilities, thresholds))
      .sort((a, b) => (a.span.end - a.span.start) - (b.span.end - b.span.start) || a.span.words.length - b.span.words.length);
    if (smaller.length) {
      const selected = smaller[0]!.span;
      const bounds = wordBounds(selected.words, selected.start, selected.end);
      const clipStart = Math.max(0, bounds.start - 0.3);
      const maxLength = Number.isFinite(maxClipSeconds) && maxClipSeconds > 0 ? maxClipSeconds : 15;
      const clipEnd = Math.min(bounds.end + 0.5, clipStart + maxLength);
      const context = quoteContext(timedSentences(transcript), selected);
      return { ...receipt, quote: selected.text, timestamp: bounds.start, quoteEnd: bounds.end,
        quoteWords: selected.words, context, clipStart, clipEnd };
    }
  }

  const fullBounds = wordBounds(full.words, full.start, full.end);
  const clipStart = Math.max(0, fullBounds.start - 0.3);
  const maxLength = Number.isFinite(maxClipSeconds) && maxClipSeconds > 0 ? maxClipSeconds : 15;
  const clipEnd = Math.min(fullBounds.end + 0.5, clipStart + maxLength);
  return { ...receipt, quote: winner.quote, timestamp: fullBounds.start, quoteEnd: fullBounds.end,
    quoteWords: full.words, clipStart, clipEnd };
}
