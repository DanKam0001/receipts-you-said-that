export interface QuoteFit { text: string; fontSize: number; startWord: number; endWord: number; truncated: boolean; }

export function receiptCountLabel(count: number): string {
  const value = Math.max(0, Math.floor(Number.isFinite(count) ? count : 0));
  return `${value} ${value === 1 ? "RECEIPT" : "RECEIPTS"}`;
}

function wrappedLines(words: string[], fontSize: number, width: number): number {
  const maxWidth = Math.max(1, width);
  const spaceWidth = fontSize * 0.31;
  const glyphWidth = (character: string) => {
    if (/[ilI.,'!:;|]/.test(character)) return 0.30;
    if (/[MW@%&]/.test(character)) return 0.88;
    if (/[A-Z]/.test(character)) return 0.67;
    if (/[0-9]/.test(character)) return 0.57;
    return 0.54;
  };
  let lines = 1, current = 0;
  for (const word of words) {
    const wordWidth = Math.max(fontSize * 0.3, [...word].reduce((sum, character) => sum + glyphWidth(character), 0) * fontSize * 1.06);
    const pieces = Math.ceil(wordWidth / maxWidth);
    if (pieces > 1) {
      if (current > 0) { lines++; current = 0; }
      lines += pieces - 1;
      current = wordWidth - (pieces - 1) * maxWidth;
    } else if (current > 0 && current + spaceWidth + wordWidth > maxWidth) {
      lines++; current = wordWidth;
    } else current += (current > 0 ? spaceWidth : 0) + wordWidth;
  }
  return lines;
}

/** Fits a verbatim quote to three lines; when shortened, the active spoken word stays visible. */
export function fitQuote(text: string, width: number, activeWordIndex = 0, maxLines = 3, minFontSize = 44, maxFontSize = 50): QuoteFit {
  const words = text.match(/\S+/g) ?? [];
  if (!words.length) return { text: "", fontSize: minFontSize, startWord: 0, endWord: 0, truncated: false };
  const safeWidth = Math.max(1, width);
  for (let fontSize = maxFontSize; fontSize >= minFontSize; fontSize -= 2) {
    if (wrappedLines(words, fontSize, safeWidth) <= maxLines)
      return { text: words.join(" "), fontSize, startWord: 0, endWord: words.length, truncated: false };
  }

  const active = Math.max(0, Math.min(words.length - 1, Math.floor(activeWordIndex)));
  let best: { start: number; end: number; shown: string[]; count: number; distance: number } | undefined;
  for (let start = 0; start <= active; start++) {
    for (let end = active + 1; end <= words.length; end++) {
      const shown = [...(start > 0 ? ["…"] : []), ...words.slice(start, end), ...(end < words.length ? ["…"] : [])];
      if (wrappedLines(shown, minFontSize, safeWidth) > maxLines) continue;
      const count = end - start, distance = Math.abs((start + end - 1) / 2 - active);
      if (!best || count > best.count || (count === best.count && distance < best.distance)) best = { start, end, shown, count, distance };
    }
  }
  if (!best) return { text: words[active]!, fontSize: minFontSize, startWord: active, endWord: active + 1, truncated: true };
  return { text: best.shown.join(" "), fontSize: minFontSize, startWord: best.start, endWord: best.end, truncated: true };
}
