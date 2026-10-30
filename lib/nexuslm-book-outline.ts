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
  backMatter: z.array(NexusLMOutlineMatterItemSchema).min(1).max(15),
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

const REQUIRED_BACK_MATTER = [
  {
    title: "Study Questions",
    aliases: ["studyquestions", "discussionquestions", "reflectionquestions"],
    purpose: "Provide source-grounded study and reflection questions grouped by chapter, derived from the completed chapters.",
  },
  {
    title: "Glossary",
    aliases: ["glossary"],
    purpose: "Define key terms used in the book as they are used in context, using only meanings supported by the completed chapters.",
  },
  {
    title: "Index of Scripture",
    aliases: ["indexofscripture", "scriptureindex", "indexofscripturereferences", "scripturereferenceindex"],
    purpose: "List Scripture references actually cited in the completed chapters and identify where each appears; do not add uncited references or verse text.",
  },
] as const;

export function includeRequiredBackMatterItems(
  items: NexusLMBookOutline["backMatter"],
): NexusLMBookOutline["backMatter"] {
  const requiredItems = new Map<string, NexusLMBookOutline["backMatter"][number]>();
  const additionalItems: NexusLMBookOutline["backMatter"] = [];

  for (const item of items) {
    const normalizedTitle = item.title.toLowerCase().replace(/[^a-z0-9]/g, "");
    const required = REQUIRED_BACK_MATTER.find((entry) => entry.aliases.some((alias) => alias === normalizedTitle));
    if (!required) {
      additionalItems.push(item);
    } else if (!requiredItems.has(required.title)) {
      requiredItems.set(required.title, { ...item, title: required.title });
    }
  }

  return [
    ...additionalItems,
    ...REQUIRED_BACK_MATTER.map((item) => requiredItems.get(item.title) ?? {
      title: item.title,
      purpose: item.purpose,
    }),
  ];
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
};

function parseOutlineCount(value: string): number | null {
  const normalized = value.toLowerCase().replace(/-/g, " ").trim();
  if (/^\d+$/.test(normalized)) return Number(normalized);
  const words = normalized.split(/\s+/);
  const base = NUMBER_WORDS[words[0]];
  if (base === undefined) return null;
  if (words.length === 1) return base;
  const remainder = NUMBER_WORDS[words[1]];
  return words.length === 2 && base >= 20 && remainder !== undefined && remainder < 10
    ? base + remainder
    : null;
}

export function parseOutlineChapterRequest(
  instruction: string,
  transcriptSlotCount: number,
): { chapterCount?: number; oneChapterPerSlot: boolean } {
  const oneChapterPerSlot = /\b(?:(?:a|one)\s+)?chapter\s+(?:per|for each|for every)\s+(?:transcript\s+)?slot\b/i.test(instruction);
  const countInstruction = instruction.replace(
    /\b(?:(?:a|one)\s+)?chapter\s+(?:per|for each|for every)\s+(?:transcript\s+)?slot\b/gi,
    " ",
  );
  const numberPattern = "(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?|thirty(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?|forty(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?)";
  const countMatch = countInstruction.match(new RegExp(`\\b(${numberPattern})[-\\s]+chapters?\\b`, "i"));
  const requestedCount = countMatch ? parseOutlineCount(countMatch[1]) : null;
  const chapterCount = requestedCount ?? (oneChapterPerSlot ? transcriptSlotCount : undefined);
  return {
    ...(chapterCount === undefined ? {} : { chapterCount }),
    oneChapterPerSlot,
  };
}

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
