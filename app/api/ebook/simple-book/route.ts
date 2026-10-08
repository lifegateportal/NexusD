import { NextRequest, NextResponse } from "next/server";
import { generateObject, generateText } from "ai";
import { z } from "zod";
import { EM_DASH_MINIMIZATION_RULES } from "@/lib/editorial-style-bible";
import { NEXUSLM_SCRIPTURE_FORMATTING_RULES } from "@/lib/scripture-formatter";
import { getEbookModel, getEbookTemperature } from "@/lib/ebook-model-selector";
import { finalizeNexusLMScripture } from "@/lib/scripture-verse";
import { NEXUSLM_WRITING_STYLES } from "@/lib/nexuslm-writing-styles";
import { NEXUSLM_RESPONSE_LENGTHS, sanitizeNexusLMText } from "@/lib/nexuslm-response";
import { VoiceDNASchema } from "@/lib/schemas/ebook";

export const runtime = "nodejs";
export const maxDuration = 300;
const generationTimeoutMs = 240_000;

const RequestSchema = z.object({
  rawTranscript: z.string().min(500).max(500000),
  slotTranscripts: z.array(z.object({
    label: z.string().min(1).max(40),
    text: z.string().min(100).max(200000),
  })).optional().default([]),
  slotNumber: z.number().int().positive().max(10).optional(),
  targetAudience: z.string().max(500).optional().default(""),
  coreThesis: z.string().max(2000).optional().default(""),
  voiceTone: z.string().max(500).optional().default(""),
  voiceDNA: VoiceDNASchema.optional(),
  authorInstructions: z.string().max(12000).optional().default(""),
  desiredChapters: z.number().int().min(3).max(12).optional().default(6),
  oneChapterPerSlot: z.boolean().optional().default(true),
  eBookModel: z.enum(["deepseek", "gemini"]).default("gemini"),
  llmTemperature: z.number().min(0).max(1).optional(),
});

const SectionSchema = z.object({
  sectionNumber: z.number().int().positive(),
  heading: z.string().default(""),
  body: z.string().default(""),
  keyClaims: z.array(z.string()).default([]),
  coveredBlockIds: z.array(z.string()).optional().default([]),
});

const ChapterSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().default(""),
  intro: z.string().default(""),
  epigraph: z.string().default(""),
  sections: z.array(SectionSchema).default([]),
  forwardQuestion: z.string().default(""),
  keyTakeaways: z.array(z.string()).default([]),
  reflectionQuestions: z.array(z.string()).default([]),
});

const SlotChapterSchema = z.object({
  title: z.string().default(""),
  intro: z.string().default(""),
  epigraph: z.string().default(""),
  sections: z.array(SectionSchema).default([]),
  forwardQuestion: z.string().default(""),
  keyTakeaways: z.array(z.string()).default([]),
  reflectionQuestions: z.array(z.string()).default([]),
});

const SimpleBookSchema = z.object({
  bookTitle: z.string().default("Untitled"),
  subtitle: z.string().default(""),
  authorName: z.string().default("the Author"),
  strategy: z.string().default("single-pass-sermon-style"),
  chapters: z.array(ChapterSchema).default([]),
});

type SimpleSourceSegment = {
  id: string;
  sourceAudio: `audio-${number}`;
  topic: string;
  rawText: string;
  estimatedWordCount: number;
};

type SimpleSectionSourceLink = {
  chapterNumber: number;
  chapterTitle: string;
  sectionNumber: number;
  heading: string;
  sourceSegmentIds: string[];
  transcriptExcerpts: string[];
  keyPoints: string[];
};

type UncoveredTeachingBlock = {
  sourceAudio: `audio-${number}`;
  chapterNumber: number;
  blockId: string;
  wordCount: number;
  excerpt: string;
};

function voiceDnaBlock(
  voiceDNA: z.infer<typeof VoiceDNASchema> | undefined,
  fallbackTone: string,
): string {
  if (!voiceDNA && !fallbackTone.trim()) return "";
  return `\n\nVOICE DNA — APPLY THROUGHOUT THE MANUSCRIPT:
- Tone: ${voiceDNA?.toneProfile || fallbackTone || "warm, clear, and reader-facing"}
- Sentence pattern: ${voiceDNA?.sentencePattern || "mixed"}
- Teaching style: ${voiceDNA?.teachingStyle || "develop ideas through concrete movement and reflection"}
- Pacing fingerprint: ${voiceDNA?.pacingFingerprint || "build deliberately toward meaningful landings"}
- Narrative device: ${voiceDNA?.narrativeDevice || "use specific moments to carry the teaching"}
- Emotional arc: ${voiceDNA?.emotionalArc || "move from honest tension toward grounded hope"}
- Opening pattern: ${voiceDNA?.openingPattern || "enter through a concrete moment or compelling question"}
- Closing pattern: ${voiceDNA?.closingPattern || "land the section with a memorable implication or invitation"}
- Preferred terminology: ${(voiceDNA?.preferredTerminology ?? []).slice(0, 10).join(", ") || "Use the source's natural vocabulary"}
- Signature phrases: ${(voiceDNA?.signaturePhrases ?? []).slice(0, 8).join(" | ") || "Use distinctive source language only when natural"}
- Avoid words: ${(voiceDNA?.avoidWords ?? []).slice(0, 20).join(", ") || "None recorded"}
- Avoid structures: ${(voiceDNA?.avoidStructures ?? []).slice(0, 10).join(" | ") || "None recorded"}
- Preserve the author's distinctive voice without copying long transcript passages verbatim.`;
}

const SIMPLE_DIRECT_SCRIPTURE_INSTRUCTION = `SCRIPTURE OUTPUT — MANDATORY:
- Render every Scripture passage as a standalone Markdown blockquote, never inline.
- Quote the complete cited verse or contiguous verse range, never a clause, excerpt, ellipsis, or partial quotation.
- Put the full citation on its own blockquote line: > — Book Chapter:Verse (Translation).
- Preserve the stated translation and verify the complete passage before returning it. Never silently substitute a translation or attach a reference to incomplete wording.`;

function buildAuthorRequestBlock(
  authorInstructions: string,
  targetAudience: string,
): string {
  return `AUTHOR'S DIRECT BOOK REQUEST — FOLLOW THIS LIKE THE USER'S NEXUSLM CHAT MESSAGE:
${authorInstructions.trim() || "No additional instructions were provided. Use your own editorial judgment."}

TARGET AUDIENCE:
${targetAudience.trim() || "(not specified)"}

Treat the direct request as the active writing brief, not as optional metadata. Follow it when deciding voice, structure, pacing, emphasis, examples, Scripture presentation, and what to omit. You have authority to interpret, synthesize, reorder, and shape the source into a finished book chapter. Do not mechanically include every transcript example. If this request conflicts with default style preferences or Voice DNA, follow the author's direct request. Preserve source-grounded factual integrity, but do not let the transcript's order or wording limit the quality of the writing.

${SIMPLE_DIRECT_SCRIPTURE_INSTRUCTION}`;
}

function buildScriptureFinalizationInstruction(authorInstructions: string): string {
  return `${SIMPLE_DIRECT_SCRIPTURE_INSTRUCTION}\n\nAUTHOR'S SCRIPTURE INSTRUCTIONS:\n${authorInstructions.trim() || "(none)"}`;
}

function nonEmptySubtitle(targetAudience: string, coreThesis: string): string {
  const audience = targetAudience.trim();
  const thesis = coreThesis.trim();
  if (audience && thesis) return `A practical guide for ${audience}`;
  if (audience) return `A field guide for ${audience}`;
  if (thesis) return "A transcript-grounded teaching journey";
  return "A transcript-grounded teaching journey";
}

function countWords(text: string): number {
  const tokens = text.trim().match(/\S+/g);
  return tokens ? tokens.length : 0;
}

type TeachingBlock = {
  id: string;
  wordCount: number;
  excerpt: string;
};

function buildTeachingBlocks(text: string): TeachingBlock[] {
  const paragraphs = text
    .split(/\n\s*\n/g)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 30);

  const chunks: string[] = [];
  let current = "";
  let currentWords = 0;
  const targetWordsPerBlock = 180;

  for (const para of paragraphs) {
    const paraWords = countWords(para);
    if (currentWords >= targetWordsPerBlock) {
      chunks.push(current.trim());
      current = para;
      currentWords = paraWords;
      continue;
    }
    current = current ? `${current} ${para}` : para;
    currentWords += paraWords;
  }
  if (current.trim()) chunks.push(current.trim());

  if (chunks.length === 0) {
    const fallbackSentences = text
      .replace(/\s+/g, " ")
      .split(/(?<=[.!?])\s+/)
      .filter(Boolean);
    const merged = fallbackSentences.join(" ");
    if (merged.trim()) chunks.push(merged.trim());
  }

  return chunks.map((chunk, idx) => ({
    id: `B${idx + 1}`,
    wordCount: countWords(chunk),
    excerpt: chunk.slice(0, 360),
  }));
}

function chapterWordCount(chapter: z.infer<typeof ChapterSchema>): number {
  return (chapter.sections ?? []).reduce((sum, section) => sum + countWords(section.body || ""), 0);
}

function missingTeachingBlocks(chapter: z.infer<typeof SlotChapterSchema>, blocks: TeachingBlock[]): string[] {
  const covered = new Set(
    (chapter.sections ?? [])
      .flatMap((section) => section.coveredBlockIds ?? [])
      .map((id) => id.trim())
      .filter(Boolean)
  );
  return blocks.map((b) => b.id).filter((id) => !covered.has(id));
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sectionVerbatimScore(sectionBody: string, sourceNormalized: string): number {
  const body = normalizeForComparison(sectionBody);
  if (!body || body.length < 320 || !sourceNormalized) return 0;

  const windowSize = 180;
  const sampleCount = 5;
  const maxStart = Math.max(0, body.length - windowSize);
  const step = Math.max(1, Math.floor(maxStart / Math.max(1, sampleCount - 1)));

  let sampled = 0;
  let matched = 0;
  for (let i = 0; i <= maxStart && sampled < sampleCount; i += step) {
    const fragment = body.slice(i, i + windowSize).trim();
    if (fragment.length < windowSize - 20) continue;
    sampled++;
    if (sourceNormalized.includes(fragment)) {
      matched++;
    }
  }

  if (sampled === 0) return 0;
  return matched / sampled;
}

function looksLikeUnprocessedTranscript(
  chapter: z.infer<typeof ChapterSchema>,
  sourceText: string,
): boolean {
  const sourceNormalized = normalizeForComparison(sourceText);
  if (!sourceNormalized) return false;

  const sections = chapter.sections ?? [];
  if (sections.length === 0) return true;

  const copiedSections = sections.filter((section) => sectionVerbatimScore(section.body || "", sourceNormalized) >= 0.6).length;
  const copiedRatio = copiedSections / sections.length;

  return copiedSections >= 2 && copiedRatio >= 0.5;
}

function buildSlotSourceSegments(slotText: string, sourceAudio: `audio-${number}`, maxSegments = 80): SimpleSourceSegment[] {
  const paragraphs = slotText
    .split(/\n\s*\n/g)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 30);

  let chunks: string[] = [];
  let current = "";
  let currentWords = 0;
  const targetWords = 150;

  for (const para of paragraphs) {
    const paraWords = countWords(para);
    if (currentWords >= targetWords && chunks.length < maxSegments - 1) {
      chunks.push(current.trim());
      current = para;
      currentWords = paraWords;
      continue;
    }
    current = current ? `${current} ${para}` : para;
    currentWords += paraWords;
  }
  if (current.trim()) {
    chunks.push(current.trim());
  }

  if (chunks.length === 0) {
    const normalized = slotText.replace(/\s+/g, " ").trim();
    if (normalized) {
      chunks.push(normalized);
    }
  }

  if (chunks.length > maxSegments) {
    const head = chunks.slice(0, maxSegments - 1);
    const overflow = chunks.slice(maxSegments - 1).join(" ");
    chunks = overflow.trim().length > 0 ? [...head, overflow] : head;
  }

  return chunks.map((rawText, idx) => {
    const firstSentence = rawText.split(/(?<=[.!?])\s+/).find((s) => s.trim().length > 12) || rawText;
    const topic = firstSentence.split(/[,:;.!?]/)[0].trim().split(/\s+/).slice(0, 8).join(" ") || `Segment ${idx + 1}`;
    return {
      id: `${sourceAudio}-seg-${idx + 1}`,
      sourceAudio,
      topic,
      rawText,
      estimatedWordCount: countWords(rawText),
    };
  });
}

function mapChapterSectionsToSourceLinks(
  chapter: z.infer<typeof ChapterSchema>,
  segments: SimpleSourceSegment[],
): SimpleSectionSourceLink[] {
  const sectionCount = Math.max(1, chapter.sections.length);
  const segmentCount = Math.max(1, segments.length);

  return chapter.sections.map((section, idx) => {
    const start = Math.floor((idx * segmentCount) / sectionCount);
    const endExclusive = Math.max(start + 1, Math.floor(((idx + 1) * segmentCount) / sectionCount));
    const chosen = segments.slice(start, endExclusive);
    const sourceSegmentIds = chosen.map((segment) => segment.id);
    const transcriptExcerpts = chosen.map((segment) => segment.rawText);

    return {
      chapterNumber: chapter.number,
      chapterTitle: chapter.title,
      sectionNumber: section.sectionNumber,
      heading: section.heading,
      sourceSegmentIds,
      transcriptExcerpts,
      keyPoints: (section.keyClaims ?? []).map((claim) => claim.trim()).filter(Boolean),
    };
  });
}

function normalizeSlotChapter(object: z.infer<typeof SlotChapterSchema>, chapterNumber: number): z.infer<typeof ChapterSchema> {
  return {
    number: chapterNumber,
    title: (object.title || `Chapter ${chapterNumber}`).trim(),
    intro: object.intro || "",
    epigraph: object.epigraph || "",
    sections: (object.sections ?? [])
      .filter((section) => (section.body || "").trim().length > 0)
      .map((section, sectionIndex) => ({
        ...section,
        sectionNumber: sectionIndex + 1,
        heading: (section.heading || `Section ${sectionIndex + 1}`).trim(),
        body: section.body || "",
      })),
    forwardQuestion: object.forwardQuestion || "",
    keyTakeaways: object.keyTakeaways ?? [],
    reflectionQuestions: object.reflectionQuestions ?? [],
  };
}

type GeneratedChapter = z.infer<typeof SlotChapterSchema> | z.infer<typeof ChapterSchema>;

async function normalizeGeneratedText(value: string, instruction: string): Promise<string> {
  return finalizeNexusLMScripture(sanitizeNexusLMText(value.trim()), instruction);
}

async function normalizeGeneratedChapter(
  object: GeneratedChapter,
  chapterNumber: number,
  instruction: string,
): Promise<z.infer<typeof ChapterSchema>> {
  const sections = await Promise.all((object.sections ?? []).map(async (section, sectionIndex) => ({
    ...section,
    sectionNumber: section.sectionNumber || sectionIndex + 1,
    heading: sanitizeNexusLMText(section.heading.trim()) || `Section ${sectionIndex + 1}`,
    body: await normalizeGeneratedText(section.body, instruction),
    keyClaims: section.keyClaims.map((claim) => sanitizeNexusLMText(claim)).filter(Boolean),
  })));

  return {
    number: chapterNumber,
    title: sanitizeNexusLMText(object.title.trim()) || `Chapter ${chapterNumber}`,
    intro: await normalizeGeneratedText(object.intro ?? "", instruction),
    epigraph: await normalizeGeneratedText(object.epigraph ?? "", instruction),
    sections: sections.filter((section) => section.body.trim().length > 0),
    forwardQuestion: await normalizeGeneratedText(object.forwardQuestion ?? "", instruction),
    keyTakeaways: await Promise.all((object.keyTakeaways ?? []).map((value) => normalizeGeneratedText(String(value), instruction))),
    reflectionQuestions: await Promise.all((object.reflectionQuestions ?? []).map((value) => normalizeGeneratedText(String(value), instruction))),
  };
}

async function normalizeSimpleBook(object: z.infer<typeof SimpleBookSchema>, input: z.infer<typeof RequestSchema>) {
  const chapters = await Promise.all((object.chapters ?? []).map((chapter, chapterIndex) =>
    normalizeGeneratedChapter(
      chapter,
      chapterIndex + 1,
      buildScriptureFinalizationInstruction(input.authorInstructions),
    )
  ));

  return {
    ...object,
    bookTitle: sanitizeNexusLMText(object.bookTitle.trim()) || "Untitled",
    subtitle: sanitizeNexusLMText(object.subtitle.trim()) || nonEmptySubtitle(input.targetAudience, input.coreThesis),
    authorName: sanitizeNexusLMText(object.authorName.trim()) || "the Author",
    strategy: sanitizeNexusLMText(object.strategy.trim()) || "single-pass-sermon-style",
    chapters,
  };
}

export async function POST(req: NextRequest) {
  const body = await req.json() as unknown;
  let input: z.infer<typeof RequestSchema>;

  try {
    input = RequestSchema.parse(body);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid request" },
      { status: 400 }
    );
  }
  const { eBookModel } = input;
  const requestedTemperature = input.llmTemperature;
  const reasoningTemperature = requestedTemperature === undefined
    ? getEbookTemperature(eBookModel, "reasoning")
    : Math.min(1, Math.max(0, requestedTemperature));

  const slotBlocks = (input.slotTranscripts ?? [])
    .filter((slot) => slot.text.trim().length > 0)
    .map((slot, idx) => {
      const sourceId = `audio-${input.slotNumber ?? idx + 1}`;
      return {
        sourceId,
        label: slot.label,
        fullText: slot.text,
        text: slot.text,
      };
    });

  const usingSlots = input.oneChapterPerSlot && slotBlocks.length > 0;
  const transcriptForPrompt = usingSlots ? "" : input.rawTranscript;
  const responseLength = NEXUSLM_RESPONSE_LENGTHS["default"];
  const maxTokens = responseLength.draftTokens;
  const voiceProfile = voiceDnaBlock(input.voiceDNA, input.voiceTone);
  const authorRequestBlock = buildAuthorRequestBlock(input.authorInstructions, input.targetAudience);

  const system = `Return only one valid JSON object matching the active schema. Do not wrap it in markdown fences and do not include reasoning outside the JSON object.
You are NexusLM, a professional book ghostwriter.
Presentation form: ${NEXUSLM_WRITING_STYLES["book-prose"].label}. ${NEXUSLM_WRITING_STYLES["book-prose"].instruction}
The source material constrains factual, theological, biographical, and scriptural truth, but it does not constrain your creative judgment about the chapter's title, introduction, section architecture, body prose, transitions, emphasis, or ending. Do not treat an existing outline, manuscript chapter, chapter premise, key point, or prior wording as mandatory. Choose the strongest material and shape a coherent chapter freely.
You may create original framing, synthesis, transitions, imagery, rhetorical movement, and reader-facing introduction when these clarify and develop ideas supported by the sources. Do not invent concrete facts, quotations, scripture references, testimonies, doctrine, or claims that the sources do not support.
Write polished reader-facing book prose and remove live-audience language. Trust your editorial judgment about what the chapter needs instead of mechanically preserving transcript order or filling a predetermined premise.
The JSON wrapper is transport only. Inside each chapter field, prioritize the same finished, immersive, reader-facing quality as a strong NexusLM chapter draft. Develop the material with specific transitions, varied rhythm, concrete supported detail, meaningful emphasis, and a satisfying ending. Do not compress chapters into notes, generic advice, transcript commentary, or a thin summary merely because the response must be valid JSON.
CHAPTER OPENING PLACEMENT: Do not write a separate premise, overview, thesis summary, or chapter-preview block before the body. The actual chapter introduction belongs in the opening paragraphs of Section 1, written as finished reader-facing prose that enters the chapter's material directly. Section 1 must begin with the chapter body, not planning language or a summary of what the chapter will discuss.
SERIES-SERMON TO BOOK TRANSFORMATION: Sermon transcripts may recap earlier messages. Treat that recap as source context, not as mandatory chapter-opening material. Do not open with "last week," "as we saw," "continuing this series," or a replay of an earlier chapter. If the recap helps orient the reader, compress it into the shortest useful bridge and pivot quickly to this chapter's new movement. Write for a reader who may not have attended the sermon, and do not make the book repeat live-series catch-up.

NON-NEGOTIABLE BOOK RULE:
4) Subtitle must be useful and reader-facing, never empty.

${EM_DASH_MINIMIZATION_RULES}
${NEXUSLM_SCRIPTURE_FORMATTING_RULES}
${voiceProfile}
Return a complete source-grounded book object. Populate intro, epigraph, forwardQuestion, keyTakeaways, and reflectionQuestions when the source and author request support them; leave a field empty rather than inventing material. Its sections must contain readable prose in the body field, not planning notes, generic advice, transcript commentary, or a thin summary. Do not expose source IDs, slot labels, retrieval markers, or internal routing labels in any field. ${responseLength.instruction}`;

  const chapterRoutingBlock = usingSlots
    ? `CHAPTER-SLOT ASSIGNMENT (HARD RULE):
- Create EXACTLY ${slotBlocks.length} chapters.
- Create exactly ONE chapter per slot.
- Chapter 1 must use only audio-1, Chapter 2 only audio-2, and so on.
- Never mix content from different source slots in the same chapter.
- If a slot is thin, still keep one chapter, but let its length and depth follow the available material. Do not invent or pad.`
    : `CHAPTER ASSIGNMENT:
- Create approximately ${input.desiredChapters} chapters from the full transcript.`;

  const sourceBlock = usingSlots
    ? slotBlocks.map((slot, idx) =>
      `[SOURCE SLOT ${idx + 1}]\nSOURCE ID: ${slot.sourceId}\nLABEL: ${slot.label}\nTRANSCRIPT:\n${slot.text}`
    ).join("\n\n" + "=".repeat(64) + "\n\n")
    : `RAW TRANSCRIPT:\n${transcriptForPrompt}`;

  const prompt = `Create a complete, source-grounded book draft with the same editorial freedom and finished-prose quality as a NexusLM chapter draft.

DESIRED CHAPTER COUNT: ${input.desiredChapters}
CORE THESIS: ${input.coreThesis || "(not provided)"}
VOICE TONE: ${input.voiceTone || "(not provided)"}
${voiceProfile}

SOURCE-TO-BOOK AUTHORITY:
- The transcript is source material, not a script, outline, or checklist.
- Decide what deserves space, what should be compressed, and what should be omitted.
- Give every chapter a coherent reader-facing arc without padding or mechanical transcript coverage.
${chapterRoutingBlock}

SOURCE MATERIAL:
${sourceBlock}

${authorRequestBlock}`;

  const storyIntegrationBlock = `LIVE EXAMPLES AND STORIES:
- Use examples, testimonies, and personal stories selectively when they clarify the chapter's strongest movement.
- Integrate only the examples that earn their place in the argument; omit repetitive, tangential, or weak material.
- Preserve vivid detail when it carries meaning, but do not extend the chapter just to include every story from the transcript.`;

  try {
    if (usingSlots && slotBlocks.length > 0) {
      const chapters: z.infer<typeof ChapterSchema>[] = [];
      const sourceSegments: SimpleSourceSegment[] = [];
      const sectionSourceLinks: SimpleSectionSourceLink[] = [];
      const uncoveredTeachingBlocks: UncoveredTeachingBlock[] = [];

      for (let i = 0; i < slotBlocks.length; i++) {
       const slot = slotBlocks[i];
       const chapterNumber = i + 1;
       const teachingBlocks = buildTeachingBlocks(slot.fullText);

        const slotPrompt = `Transform SOURCE SLOT ${chapterNumber} into one complete chapter.

HARD ASSIGNMENT:
- Produce exactly ONE chapter from this slot.
- Use only this slot's transcript material.
- Output ONLY a chapter object (not a full book object).
- These source and output boundaries are the only hard constraints. Within them, choose the strongest title, section architecture, body prose, transitions, emphasis, pacing, and ending freely.
- Populate intro, epigraph, forwardQuestion, keyTakeaways, and reflectionQuestions when supported. These fields must be finished reader-facing material, never planning notes.
- Write enough finished prose to fully develop the source's central movement; do not stop at a skeletal summary. Expand supported ideas with explanation, concrete detail, and reader-facing application. Let final length follow the source rather than a fixed word target.

CHAPTER CONTEXT:
CHAPTER NUMBER: ${chapterNumber}
CORE THESIS: ${input.coreThesis || "(not provided)"}
VOICE TONE: ${input.voiceTone || "(not provided)"}

${storyIntegrationBlock}

SECTION FLOW:
- Begin section 1 directly with a concrete, reader-facing entrance drawn from the source. Do not add a separate premise summary, orientation paragraph, or "this chapter" introduction.
- Let later sections advance from new material; do not repeatedly re-introduce the chapter premise or opening hook.
- Use transitions, emphasis, and rhetorical movement when they clarify the chapter's argument. Avoid generic previews and recap padding.
- Give the final section a satisfying closure without mechanically re-listing prior points.

SCRIPTURE PRESENTATION:
${SIMPLE_DIRECT_SCRIPTURE_INSTRUCTION}

SOURCE SLOT:
LABEL: ${slot.label}
TRANSCRIPT:
${slot.text}

${authorRequestBlock}`;

        let chapterObject: z.infer<typeof SlotChapterSchema> | null = null;
        let lastGenerationError = "";

        for (let attempt = 0; attempt < 2; attempt++) {
          const attemptPrompt = attempt === 0
            ? slotPrompt
            : `${slotPrompt}\n\nREVISION REQUIRED:\n- Prior attempt copied transcript phrasing too closely or failed structure.\n- Rewrite with stronger synthesis, cleaner transitions, and no long verbatim transcript spans.\n- Keep strict source grounding and keep all significant teaching blocks covered.`;
          try {
            const { object } = await generateObject({
              model: getEbookModel(eBookModel),
              schema: SlotChapterSchema,
              mode: "json",
              temperature: reasoningTemperature,
              maxTokens,
              system,
              prompt: attemptPrompt,
              abortSignal: AbortSignal.timeout(generationTimeoutMs),
            });
            const normalizedCandidate = normalizeSlotChapter(object, chapterNumber);
            if (normalizedCandidate.sections.length === 0) {
              continue;
            }
            if (looksLikeUnprocessedTranscript(normalizedCandidate, slot.fullText)) {
              continue;
            }
            chapterObject = object;
            break;
          } catch (err) {
            lastGenerationError = err instanceof Error ? err.message : String(err);
            // Retry structured generation with the same model and schema.
          }
        }

        if (!chapterObject) {
          try {
            const { text } = await generateText({
              model: getEbookModel(eBookModel),
              temperature: reasoningTemperature,
              maxTokens,
              system,
              prompt: `${slotPrompt}\n\nReturn only valid JSON for this chapter object. Do not include markdown fences or commentary.`,
              abortSignal: AbortSignal.timeout(generationTimeoutMs),
            });
            const json = extractFirstJsonObject(text);
            if (json) {
              const parsed = SlotChapterSchema.safeParse(JSON.parse(json));
              if (parsed.success) {
                const normalizedCandidate = normalizeSlotChapter(parsed.data, chapterNumber);
                if (normalizedCandidate.sections.length > 0 && !looksLikeUnprocessedTranscript(normalizedCandidate, slot.fullText)) {
                  chapterObject = parsed.data;
                }
              }
            }
          } catch (err) {
            lastGenerationError = err instanceof Error ? err.message : String(err);
          }
        }

        if (!chapterObject) {
          return NextResponse.json(
            {
              error: `Simple book generation failed: slot ${chapterNumber} did not return valid structured output`,
              details: lastGenerationError || "The model returned no usable sections after retries.",
            },
            { status: 502 }
          );
        }

        const normalizedChapter = await normalizeGeneratedChapter(
          chapterObject,
          chapterNumber,
          buildScriptureFinalizationInstruction(input.authorInstructions),
        );
        if (normalizedChapter.sections.length === 0) {
          return NextResponse.json(
            { error: `Simple book generation failed: slot ${chapterNumber} produced no section content` },
            { status: 502 }
          );
        }
        if (looksLikeUnprocessedTranscript(normalizedChapter, slot.fullText)) {
          return NextResponse.json(
            { error: `Simple book generation failed: slot ${chapterNumber} returned unprocessed transcript-like output` },
            { status: 502 }
          );
        }

        const uncoveredBlocks = missingTeachingBlocks(normalizedChapter, teachingBlocks);
        if (uncoveredBlocks.length > 0) {
          const missing = new Set(uncoveredBlocks);
          const uncoveredForSlot = teachingBlocks
            .filter((block) => missing.has(block.id))
            .map((block) => ({
              sourceAudio: slot.sourceId as `audio-${number}`,
              chapterNumber,
              blockId: block.id,
              wordCount: block.wordCount,
              excerpt: block.excerpt,
            }));
          uncoveredTeachingBlocks.push(...uncoveredForSlot);
        }

        const sourceAudio = slot.sourceId as `audio-${number}`;
        const slotSegments = buildSlotSourceSegments(slot.fullText, sourceAudio);
        const slotLinks = mapChapterSectionsToSourceLinks(normalizedChapter, slotSegments);

        chapters.push(normalizedChapter);
        sourceSegments.push(...slotSegments);
        sectionSourceLinks.push(...slotLinks);
      }

      const bookFromSlots: z.infer<typeof SimpleBookSchema> = {
        bookTitle: (chapters[0]?.title || "Untitled").trim(),
        subtitle: nonEmptySubtitle(input.targetAudience, input.coreThesis),
        authorName: "the Author",
        strategy: "slot-by-slot-sermon-style",
        chapters,
      };

      const normalizedSlotsBook = await normalizeSimpleBook(bookFromSlots, input);
      return NextResponse.json({
        ...normalizedSlotsBook,
        sourceSegments,
        sectionSourceLinks,
        uncoveredTeachingBlocks,
      });
    }

    let lastGenerationError = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { object } = await generateObject({
          model: getEbookModel(eBookModel),
          schema: SimpleBookSchema,
          mode: "json",
          temperature: reasoningTemperature,
          maxTokens,
          system,
          prompt: `${prompt}\n\n${storyIntegrationBlock}`,
          abortSignal: AbortSignal.timeout(generationTimeoutMs),
        });
        const normalized = await normalizeSimpleBook(object, input);
        if (normalized.chapters.length > 0) {
          return NextResponse.json(normalized);
        }
      } catch (err) {
        lastGenerationError = err instanceof Error ? err.message : String(err);
        // Retry structured generation with the same model and schema.
      }
    }
    return NextResponse.json(
      {
        error: "Simple book generation failed: structured model output was unavailable after retries",
        details: lastGenerationError || "The model returned no usable chapters after retries.",
      },
      { status: 502 }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Simple book generation failed" },
      { status: 500 }
    );
  }
}
