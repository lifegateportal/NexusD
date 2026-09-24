import { NextRequest, NextResponse } from "next/server";
import { generateObject, generateText } from "ai";
import { z } from "zod";
import { READER_NORMALIZATION_RULES, SOURCE_LOCK_RULES } from "@/lib/editorial-style-bible";
import { SCRIPTURE_FORMATTING_RULES } from "@/lib/scripture-formatter";
import { getEbookModel, getEbookTemperature } from "@/lib/ebook-model-selector";

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
  authorInstructions: z.string().max(4000).optional().default(""),
  desiredChapters: z.number().int().min(3).max(12).optional().default(6),
  oneChapterPerSlot: z.boolean().optional().default(true),
  eBookModel: z.enum(["deepseek", "gemini"]).default("deepseek"),
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
  sections: z.array(SectionSchema).default([]),
});

const SlotChapterSchema = z.object({
  title: z.string().default(""),
  sections: z.array(SectionSchema).default([]),
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

function normalizeSimpleBook(object: z.infer<typeof SimpleBookSchema>, input: z.infer<typeof RequestSchema>) {
  return {
    ...object,
    subtitle: (object.subtitle || "").trim() || nonEmptySubtitle(input.targetAudience, input.coreThesis),
    strategy: (object.strategy || "single-pass-sermon-style").trim(),
    chapters: (object.chapters ?? [])
      .map((chapter, chapterIndex) => ({
        ...chapter,
        number: chapterIndex + 1,
        title: (chapter.title || `Chapter ${chapterIndex + 1}`).trim(),
        sections: (chapter.sections ?? [])
          .filter((section) => (section.body || "").trim().length > 0)
          .map((section, sectionIndex) => ({
            ...section,
            sectionNumber: sectionIndex + 1,
            heading: (section.heading || `Section ${sectionIndex + 1}`).trim(),
            body: section.body || "",
          })),
      }))
      .filter((chapter) => chapter.sections.length > 0),
  };
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
    sections: (object.sections ?? [])
      .filter((section) => (section.body || "").trim().length > 0)
      .map((section, sectionIndex) => ({
        ...section,
        sectionNumber: sectionIndex + 1,
        heading: (section.heading || `Section ${sectionIndex + 1}`).trim(),
        body: section.body || "",
      })),
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
  const maxTokens = usingSlots ? 22000 : 24000;

  const system = `You are a bestselling nonfiction ghostwriter commissioned to transform sermon transcripts into a premium, publication-ready book manuscript.

You must produce a clean, publication-ready book draft from sermon transcript material using one deterministic philosophy:
- Simple and direct structure like Sermon Assistant
- Strong chapter titles and section headings
- Avoid redundant concept re-development across sections and chapters
- Strict transcript grounding
Write the strongest coherent, publication-ready nonfiction book supported by the source. Use your judgment about chapter architecture, section count, section length, titles, pacing, transitions, callbacks, and closure. Favor specific, vivid, reader-facing prose over a mechanical outline.

NON-NEGOTIABLE RULES:
1) Section count is content-driven. Choose as many sections as needed for clear flow and full coverage.
2) Chapter titles must be 4-7 words, punchy, complete phrases.
3) Section headings must be 4-8 words, complete phrases, never dangling.
4) Subtitle must be useful and reader-facing, never empty.
5) No duplication: once a concept is fully developed in one section, do not repeat it in later sections.
6) Keep chronological integrity unless a minimal reorder is required for clarity.
7) Every section body must be transcript-grounded and specific.
8) Avoid generic headings like Introduction, Overview, Summary, Conclusion.
9) Output valid JSON only.
10) Write full-length chapter prose: target 700-1000 words per section when content supports it so each chapter lands around 3500-4500 words.
11) Preserve scripture fidelity and render scripture with premium readability.
12) Preserve and integrate live examples/stories from the transcript. Do not strip them out. Use them as evidence that advances the teaching point.
13) Story discipline: setup, tension, and payoff must stay in order and attach to the section argument.
14) Never duplicate a full story in multiple sections. If recalled later, reference briefly and move forward.
15) Remove all pulpit and live-audience language from narration. Forbidden examples: "say amen", "turn to your neighbor", "lift your hands", "good morning church".
16) Thoroughness is mandatory: cover the full transcript and all significant teaching blocks, not just highlights, but never restate the same core claim in multiple sections to prove coverage.
17) Never paste transcript blocks verbatim. Rewrite into publication-ready prose with clear section flow and transitions.
18) SECTION ENDING RULE: For every non-final section, the final sentence must create forward pull from that section's own content. Use an unresolved tension, implication, contrast, or hinge statement. A question is optional, not required. Do not close non-final sections with a recap sentence.
19) FINAL SECTION RULE: Only the last section may deliver chapter closure. Keep it decisive and do not add a recap paragraph that re-lists prior section points.
20) CONCEPT OWNERSHIP: The first section that develops a concept owns it. Later sections may reference it in one short clause only; they must contribute new movement, not re-development.
21) CHAPTER OPENER SCOPE: Only section 1 may include a chapter-orientation opener. Keep it simple: one short opening paragraph (about 60-110 words) that helps the reader land in the chapter's core burden before deeper exposition.
22) CHAPTER BODY INTRODUCTION: In the first paragraph of section 1, the opening sentence should echo the spirit of the chapter premise without quoting it verbatim. Let it orient the reader toward the central tension or claim, then let the following paragraphs build from that momentum.
23) NO RE-INTRODUCTIONS: Sections 2+ must not re-introduce the chapter gist, thesis framing, or opening hook language. Continue the argument directly from new movement.
AUTHOR CONFIGURATION POLICY:
- Treat TARGET AUDIENCE and AUTHOR INSTRUCTIONS as high-priority presentation directives.
- Apply them to voice, structure, emphasis, pacing, framing, and reader experience across the manuscript.
- These directives never permit source invention. If an instruction requires facts not present in transcript material, keep source fidelity and write less.

${SOURCE_LOCK_RULES}

${READER_NORMALIZATION_RULES}

NARRATIVE VOICE HARD BAN:
- Never describe the source from outside the book with phrases such as "the speaker said," "the author said," "the preacher said," "the message says," or "in this sermon/message."
- Write the teaching directly as reader-facing book prose. Preserve first-person language only when the transcript contains the author's own testimony or experience.
- Before returning JSON, scan every chapter title, heading, premise, and section body for these narrator phrases and rewrite them.

PROSE PRINCIPLES:
- Write clear, direct, publication-ready prose for a reader, not a live audience.
- Use your judgment for chapter architecture, sentence rhythm, transitions, emphasis, section structure, pacing, and closure.
- Do not pad thin source material or mechanically remove words from finished prose.`;

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

  const prompt = `Create a simple, sermon-assistant-style book in one pass.

DESIRED CHAPTER COUNT: ${input.desiredChapters}
TARGET AUDIENCE: ${input.targetAudience || "(not provided)"}
CORE THESIS: ${input.coreThesis || "(not provided)"}
VOICE TONE: ${input.voiceTone || "(not provided)"}
AUTHOR INSTRUCTIONS: ${input.authorInstructions || "(not provided)"}

AUTHOR CONFIGURATION APPLICATION:
- Use TARGET AUDIENCE and AUTHOR INSTRUCTIONS as high-priority guidance for presentation choices.
- Honor these directives in chapter flow, section voice, framing, and rhetorical delivery.
- Do not invent new ideas, examples, facts, or theology to satisfy directives.
${chapterRoutingBlock}

SCRIPTURE FORMATTING:
${SCRIPTURE_FORMATTING_RULES}

SOURCE MATERIAL:
${sourceBlock}`;

  const storyIntegrationBlock = `LIVE EXAMPLES AND STORIES (NON-NEGOTIABLE):
- Keep the speaker's live examples, testimonies, and personal stories in the chapter.
- Integrate each story into the argument, not as a detached anecdote.
- Draw the teaching implication at the story's turning point or landing, then move forward. Do not restate the same implication repeatedly after each story beat.
- Do not flatten vivid details that carry emotional force unless they are repetitive noise.`;

  try {
    if (usingSlots && slotBlocks.length > 0) {
      const chapters: z.infer<typeof ChapterSchema>[] = [];
      const sourceSegments: SimpleSourceSegment[] = [];
      const sectionSourceLinks: SimpleSectionSourceLink[] = [];
      const uncoveredTeachingBlocks: UncoveredTeachingBlock[] = [];
      let allSectionClaims: string[] = [];

      for (let i = 0; i < slotBlocks.length; i++) {
        const slot = slotBlocks[i];
        const chapterNumber = i + 1;
          const teachingBlocks = buildTeachingBlocks(slot.fullText);
        const teachingBlockManifest = teachingBlocks.length > 0
          ? teachingBlocks.map((b) => `- ${b.id} (${b.wordCount} words): ${b.excerpt}`).join("\n")
          : "- B1: (no extracted block; use full transcript coverage)";
        const priorClaimsBlock = allSectionClaims.length > 0
          ? `\n\nPRIOR CHAPTER CLAIMS (DO NOT REPEAT IN FULL):\n${allSectionClaims.slice(-30).map((c) => `- ${c}`).join("\n")}`
          : "";

        const slotPrompt = `Transform SOURCE SLOT ${chapterNumber} into one complete chapter.

HARD ASSIGNMENT:
- Produce exactly ONE chapter from this slot.
- Use only this slot's transcript material.
- Output ONLY a chapter object (not a full book object).

CHAPTER CONTEXT:
CHAPTER NUMBER: ${chapterNumber}
TARGET AUDIENCE: ${input.targetAudience || "(not provided)"}
CORE THESIS: ${input.coreThesis || "(not provided)"}
VOICE TONE: ${input.voiceTone || "(not provided)"}
AUTHOR INSTRUCTIONS: ${input.authorInstructions || "(not provided)"}

AUTHOR CONFIGURATION APPLICATION (HARD RULE):
- Treat TARGET AUDIENCE and AUTHOR INSTRUCTIONS as high-priority presentation directives for this chapter.
- Apply them to chapter shape, section emphasis, sentence rhythm, and reader-facing clarity.
- Never invent source content to satisfy them; keep strict transcript grounding.

TEACHING BLOCK COVERAGE GUIDANCE:
- Use the significant teaching blocks as source guidance and prioritize material that serves the chapter's clearest argument.
- Each section must declare coveredBlockIds.
- Combine related blocks naturally; do not force minor or repetitive material into the chapter.

SIGNIFICANT TEACHING BLOCKS:
${teachingBlockManifest}

${storyIntegrationBlock}

SCRIPTURE FORMATTING:
${SCRIPTURE_FORMATTING_RULES}

SECTION FLOW:
- Begin section 1 directly with a concrete, reader-facing entrance drawn from the source. Do not add a premise summary, orientation paragraph, or "this chapter" introduction.
- Let later sections advance from new material; do not repeatedly re-introduce the chapter premise or opening hook.
- Let each section end according to its own material. Avoid manufactured bridges, previews, and recap paragraphs.
- Give the final section a satisfying closure without mechanically re-listing prior points.

SOURCE SLOT:
SOURCE ID: ${slot.sourceId}
LABEL: ${slot.label}
TRANSCRIPT:
${slot.text}${priorClaimsBlock}`;

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

        const normalizedChapter = normalizeSlotChapter(chapterObject, chapterNumber);
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
        allSectionClaims = [
          ...allSectionClaims,
          ...normalizedChapter.sections.flatMap((section) => (section.keyClaims ?? []).map((claim) => claim.trim()).filter(Boolean)),
        ];
      }

      const bookFromSlots: z.infer<typeof SimpleBookSchema> = {
        bookTitle: (chapters[0]?.title || "Untitled").trim(),
        subtitle: nonEmptySubtitle(input.targetAudience, input.coreThesis),
        authorName: "the Author",
        strategy: "slot-by-slot-sermon-style",
        chapters,
      };

      const normalizedSlotsBook = normalizeSimpleBook(bookFromSlots, input);
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
        const normalized = normalizeSimpleBook(object, input);
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
