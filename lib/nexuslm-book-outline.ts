import { z } from "zod";

export const NexusLMOutlineSectionSchema = z.object({
  heading: z.string().trim().min(1).max(200),
  purpose: z.string().trim().min(1).max(1200),
}).strict();

export const NexusLMOutlineChapterSchema = z.object({
  number: z.number().int().positive().max(100),
  title: z.string().trim().min(1).max(300),
  purpose: z.string().trim().min(1).max(2000),
  sections: z.array(NexusLMOutlineSectionSchema).min(1).max(12),
}).strict();

export const NexusLMOutlineMatterItemSchema = z.object({
  title: z.string().trim().min(1).max(200),
  purpose: z.string().trim().min(1).max(1200),
}).strict();

export const NexusLMBookOutlineSchema = z.object({
  bookTitle: z.string().trim().min(1).max(300),
  subtitle: z.string().max(500),
  coreThesis: z.string().trim().min(1).max(2000),
  targetReader: z.string().trim().min(1).max(1200),
  chapters: z.array(NexusLMOutlineChapterSchema).min(1).max(40),
  frontMatter: z.array(NexusLMOutlineMatterItemSchema).min(1).max(12),
  backMatter: z.array(NexusLMOutlineMatterItemSchema).min(1).max(12),
}).strict();

export const NexusLMOutlineContinuationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("chapter"),
    chapterNumber: z.number().int().positive().max(100),
    transcriptLabel: z.string().min(1).max(200).nullable().optional(),
  }).strict(),
  z.object({
    kind: z.literal("frontMatter"),
    transcriptLabel: z.string().min(1).max(200).nullable().optional(),
  }).strict(),
  z.object({
    kind: z.literal("backMatter"),
    transcriptLabel: z.string().min(1).max(200).nullable().optional(),
  }).strict(),
]);

export type NexusLMBookOutline = z.infer<typeof NexusLMBookOutlineSchema>;
export type NexusLMOutlineContinuation = z.infer<typeof NexusLMOutlineContinuationSchema>;

export function getNextOutlineContinuation(
  outline: NexusLMBookOutline,
  completedChapterNumbers: number[],
  frontMatterText = "",
  backMatterText = "",
  transcriptLabel: string | null = null,
): NexusLMOutlineContinuation | null {
  const completed = new Set(completedChapterNumbers);
  const nextChapter = outline.chapters.find((chapter) => !completed.has(chapter.number));
  if (nextChapter) {
    return { kind: "chapter", chapterNumber: nextChapter.number, transcriptLabel };
  }
  if (outline.frontMatter.length > 0 && !frontMatterText.trim()) {
    return { kind: "frontMatter", transcriptLabel };
  }
  if (outline.backMatter.length > 0 && !backMatterText.trim()) {
    return { kind: "backMatter", transcriptLabel };
  }
  return null;
}

export function explicitTranscriptSlotNumber(instruction: string): number | null {
  const match = instruction.match(/\bslot\s*#?\s*(\d+)\b/i);
  if (!match) return null;
  const slotNumber = Number(match[1]);
  return Number.isSafeInteger(slotNumber) ? slotNumber : Number.MAX_SAFE_INTEGER;
}

export function transcriptForExplicitSlot<T extends { label: string }>(
  transcripts: T[],
  slotNumber: number,
): T | null {
  const labeledSlot = transcripts.find((transcript) => (
    new RegExp(`\\bslot\\s*#?\\s*${slotNumber}\\b`, "i").test(transcript.label)
  ));
  return labeledSlot ?? (slotNumber > 0 ? transcripts[slotNumber - 1] ?? null : null);
}

export function formatOutlineContinuation(continuation: NexusLMOutlineContinuation, outline: NexusLMBookOutline): string {
  if (continuation.kind === "chapter") {
    const chapter = outline.chapters.find((item) => item.number === continuation.chapterNumber);
    return chapter
      ? `Chapter ${chapter.number}: ${chapter.title}`
      : `Chapter ${continuation.chapterNumber}`;
  }
  return continuation.kind === "frontMatter" ? "the outlined front matter" : "the outlined back matter";
}

export function isOutlineContinuationAffirmative(instruction: string): boolean {
  return /^(?:yes|y|yeah|yep|sure|okay|ok|go ahead|continue|next|write next|do it|please do)\b/i.test(instruction.trim());
}

export function isOutlineContinuationDecline(instruction: string): boolean {
  return /^(?:no|not now|stop|pause|later)\b/i.test(instruction.trim());
}
