import type { LibraryVideoSegment } from "@/lib/schemas/library-video";
import type { ShortTranscriptCut } from "@/lib/schemas/video-short";

export type TranscriptWord = {
  text: string;
  index: number;
};

export function getTranscriptWords(text: string): TranscriptWord[] {
  return [...text.matchAll(/\S+/g)].map((match, index) => ({
    text: match[0],
    index,
  }));
}

export function getDeletedTranscriptWordIndexes(
  previousText: string,
  nextText: string,
): number[] | null {
  const previousWords = getTranscriptWords(previousText);
  const nextWords = getTranscriptWords(nextText);
  const deletedIndexes: number[] = [];
  let nextIndex = 0;

  for (const word of previousWords) {
    if (word.text === nextWords[nextIndex]?.text) {
      nextIndex += 1;
    } else {
      deletedIndexes.push(word.index);
    }
  }

  return nextIndex === nextWords.length ? deletedIndexes : null;
}

export function getTranscriptWordTimeRange(
  segment: LibraryVideoSegment,
  wordIndex: number,
  clipStartSeconds: number,
  clipEndSeconds: number,
): { startSeconds: number; endSeconds: number } | null {
  const words = getTranscriptWords(segment.text);
  const word = words[wordIndex];
  const duration = segment.endSeconds - segment.startSeconds;
  if (!word || duration <= 0) return null;

  const weights = words.map(({ text }) => Math.max(1, Array.from(text).length));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const startWeight = weights.slice(0, wordIndex).reduce((sum, weight) => sum + weight, 0);
  const startSeconds = Math.max(
    segment.startSeconds + duration * startWeight / totalWeight,
    clipStartSeconds,
  );
  const endSeconds = Math.min(
    segment.startSeconds + duration * (startWeight + weights[wordIndex]) / totalWeight,
    clipEndSeconds,
  );

  return endSeconds > startSeconds ? { startSeconds, endSeconds } : null;
}

export function getRemovedTranscriptWordIndexes(
  cuts: ShortTranscriptCut[],
): Map<number, Set<number>> {
  const removedWords = new Map<number, Set<number>>();
  for (const cut of cuts) {
    const indexes = removedWords.get(cut.segmentIndex) ?? new Set<number>();
    indexes.add(cut.wordIndex);
    removedWords.set(cut.segmentIndex, indexes);
  }
  return removedWords;
}

export function getEditedTranscriptText(
  text: string,
  segmentIndex: number,
  removedWords: ReadonlyMap<number, ReadonlySet<number>>,
): string {
  const removedIndexes = removedWords.get(segmentIndex);
  if (!removedIndexes?.size) return text;
  return getTranscriptWords(text)
    .filter((word) => !removedIndexes.has(word.index))
    .map((word) => word.text)
    .join(" ");
}

export function getTranscriptCutAtTime(
  cuts: ShortTranscriptCut[],
  timeSeconds: number,
): ShortTranscriptCut | undefined {
  return cuts.find((cut) =>
    timeSeconds >= cut.startSeconds && timeSeconds < cut.endSeconds,
  );
}
