import type { LibraryVideoSegment } from "@/lib/schemas/library-video";

const MAX_CAPTION_CHARACTERS = 36;

function splitLongWord(word: string): string[] {
  const characters = Array.from(word);
  const parts: string[] = [];
  for (let index = 0; index < characters.length; index += MAX_CAPTION_CHARACTERS) {
    parts.push(characters.slice(index, index + MAX_CAPTION_CHARACTERS).join(""));
  }
  return parts;
}

type TimedWord = { text: string; wordIndex: number };

function splitCaptionWords(text: string): TimedWord[] {
  return text.trim().split(/\s+/).flatMap((word, wordIndex) =>
    (word.length > MAX_CAPTION_CHARACTERS ? splitLongWord(word) : [word])
      .map((textPart) => ({ text: textPart, wordIndex })),
  );
}

function splitCaptionChunks(text: string): TimedWord[][] {
  const words = splitCaptionWords(text);
  const chunks: TimedWord[][] = [];
  let chunk: TimedWord[] = [];

  for (const word of words) {
    const candidate = chunk.length
      ? `${chunk.map((part) => part.text).join(" ")} ${word.text}`
      : word.text;
    if (chunk.length > 0 && candidate.length > MAX_CAPTION_CHARACTERS) {
      chunks.push(chunk);
      chunk = [word];
    } else {
      chunk = [...chunk, word];
    }

    const chunkText = chunk.map((part) => part.text).join(" ");
    if (/[.!?;:,]$/.test(chunkText) && chunkText.length >= MAX_CAPTION_CHARACTERS * 0.55) {
      chunks.push(chunk);
      chunk = [];
    }
  }

  if (chunk.length > 0) chunks.push(chunk);
  return chunks.length > 0 ? chunks : [[{ text, wordIndex: 0 }]];
}

export function buildTimedCaptionCues(
  captions: LibraryVideoSegment[],
  removedWords: ReadonlyMap<number, ReadonlySet<number>> = new Map(),
): LibraryVideoSegment[] {
  return captions.flatMap((caption, captionIndex) => {
    const chunks = splitCaptionChunks(caption.text);
    const removedWordIndexes = removedWords.get(captionIndex);
    if (chunks.length === 1) {
      const text = chunks[0]
        .filter((word) => !removedWordIndexes?.has(word.wordIndex))
        .map((word) => word.text)
        .join(" ");
      return text ? [{ ...caption, text }] : [];
    }

    const totalWords = chunks.reduce((total, chunk) => total + chunk.length, 0);
    let elapsedWords = 0;
    return chunks.flatMap((chunk, index) => {
      const startSeconds = caption.startSeconds
        + (caption.endSeconds - caption.startSeconds) * elapsedWords / totalWords;
      elapsedWords += chunk.length;
      const endSeconds = index === chunks.length - 1
        ? caption.endSeconds
        : caption.startSeconds
          + (caption.endSeconds - caption.startSeconds) * elapsedWords / totalWords;
      const text = chunk
        .filter((word) => !removedWordIndexes?.has(word.wordIndex))
        .map((word) => word.text)
        .join(" ");
      return text ? [{ startSeconds, endSeconds, text }] : [];
    });
  });
}
