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

function splitCaptionText(text: string): string[] {
  const words = text.trim().split(/\s+/).flatMap((word) =>
    word.length > MAX_CAPTION_CHARACTERS ? splitLongWord(word) : [word],
  );
  const chunks: string[] = [];
  let chunk = "";

  for (const word of words) {
    const candidate = chunk ? `${chunk} ${word}` : word;
    if (chunk && candidate.length > MAX_CAPTION_CHARACTERS) {
      chunks.push(chunk);
      chunk = word;
    } else {
      chunk = candidate;
    }

    if (/[.!?;:,]$/.test(chunk) && chunk.length >= MAX_CAPTION_CHARACTERS * 0.55) {
      chunks.push(chunk);
      chunk = "";
    }
  }

  if (chunk) chunks.push(chunk);
  return chunks.length > 0 ? chunks : [text];
}

export function buildTimedCaptionCues(
  captions: LibraryVideoSegment[],
): LibraryVideoSegment[] {
  return captions.flatMap((caption) => {
    const chunks = splitCaptionText(caption.text);
    if (chunks.length === 1) return [caption];

    const totalWords = chunks.reduce((total, chunk) => total + chunk.split(/\s+/).length, 0);
    let elapsedWords = 0;
    return chunks.map((text, index) => {
      const startSeconds = caption.startSeconds
        + (caption.endSeconds - caption.startSeconds) * elapsedWords / totalWords;
      elapsedWords += text.split(/\s+/).length;
      const endSeconds = index === chunks.length - 1
        ? caption.endSeconds
        : caption.startSeconds
          + (caption.endSeconds - caption.startSeconds) * elapsedWords / totalWords;
      return { startSeconds, endSeconds, text };
    });
  });
}
