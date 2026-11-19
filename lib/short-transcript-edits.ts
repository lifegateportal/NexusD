import type { LibraryVideoSegment } from "@/lib/schemas/library-video";
import type { ShortTranscriptCut } from "@/lib/schemas/video-short";

export type TranscriptWord = {
  text: string;
  index: number;
};

export type AudioWordTiming = {
  text: string;
  startSeconds: number;
  endSeconds: number;
};

export type AlignedTranscriptWordTiming = {
  segmentIndex: number;
  wordIndex: number;
  startSeconds: number;
  endSeconds: number;
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
  exactRange?: { startSeconds: number; endSeconds: number },
): { startSeconds: number; endSeconds: number } | null {
  const words = getTranscriptWords(segment.text);
  const word = words[wordIndex];
  const duration = segment.endSeconds - segment.startSeconds;
  if (!word || duration <= 0) return null;
  if (
    exactRange
    && exactRange.startSeconds >= segment.startSeconds
    && exactRange.endSeconds <= segment.endSeconds
  ) {
    const startSeconds = Math.max(exactRange.startSeconds, clipStartSeconds);
    const endSeconds = Math.min(exactRange.endSeconds, clipEndSeconds);
    if (endSeconds > startSeconds) return { startSeconds, endSeconds };
  }

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

export function alignTranscriptWordTimings(
  captions: LibraryVideoSegment[],
  audioWords: AudioWordTiming[],
  clipStartSeconds: number,
  clipEndSeconds: number,
): { wordTimings: AlignedTranscriptWordTiming[]; totalWords: number } {
  const normalize = (value: string) => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const transcriptWords = captions.flatMap((caption, segmentIndex) =>
    getTranscriptWords(caption.text).map((word) => ({
      segmentIndex,
      wordIndex: word.index,
      normalized: normalize(word.text),
      caption,
    })),
  );
  const wordTimings: AlignedTranscriptWordTiming[] = [];
  let transcriptIndex = 0;
  let audioIndex = 0;
  while (transcriptIndex < transcriptWords.length && audioIndex < audioWords.length) {
    let match: { transcriptIndex: number; audioIndex: number; distance: number } | null = null;
    for (let transcriptLookahead = transcriptIndex; transcriptLookahead < Math.min(transcriptIndex + 5, transcriptWords.length); transcriptLookahead += 1) {
      const transcriptWord = transcriptWords[transcriptLookahead];
      if (!transcriptWord.normalized) continue;
      for (let audioLookahead = audioIndex; audioLookahead < Math.min(audioIndex + 7, audioWords.length); audioLookahead += 1) {
        if (transcriptWord.normalized !== normalize(audioWords[audioLookahead].text)) continue;
        const distance = transcriptLookahead - transcriptIndex + audioLookahead - audioIndex;
        if (!match || distance < match.distance) {
          match = { transcriptIndex: transcriptLookahead, audioIndex: audioLookahead, distance };
        }
      }
    }
    if (!match) {
      transcriptIndex += 1;
      audioIndex += 1;
      continue;
    }

    const transcriptWord = transcriptWords[match.transcriptIndex];
    const audioWord = audioWords[match.audioIndex];
    if (
      audioWord.startSeconds >= clipStartSeconds
      && audioWord.endSeconds <= clipEndSeconds
      && audioWord.startSeconds >= transcriptWord.caption.startSeconds
      && audioWord.endSeconds <= transcriptWord.caption.endSeconds
      && audioWord.endSeconds > audioWord.startSeconds
    ) {
      wordTimings.push({
        segmentIndex: transcriptWord.segmentIndex,
        wordIndex: transcriptWord.wordIndex,
        startSeconds: audioWord.startSeconds,
        endSeconds: audioWord.endSeconds,
      });
    }
    transcriptIndex = match.transcriptIndex + 1;
    audioIndex = match.audioIndex + 1;
  }
  return { wordTimings, totalWords: transcriptWords.length };
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
  cuts: ReadonlyArray<{ id: string; startSeconds: number; endSeconds: number }>,
  timeSeconds: number,
): { id: string; startSeconds: number; endSeconds: number } | undefined {
  return cuts.find((cut) =>
    timeSeconds >= cut.startSeconds && timeSeconds < cut.endSeconds,
  );
}
