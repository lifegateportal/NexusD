import { NextRequest, NextResponse } from "next/server";
import { generateObject, generateText } from "ai";
import { z } from "zod";
import { deepSeekReasonerModel } from "@/lib/ai-providers";
import { SOURCE_LOCK_RULES, stripAudienceLanguage } from "@/lib/editorial-style-bible";
import { SCRIPTURE_FORMATTING_RULES } from "@/lib/scripture-formatter";
import { getEbookModel, getEbookTemperature } from "@/lib/ebook-model-selector";

export const runtime = "nodejs";
export const maxDuration = 300;

const RequestSchema = z.object({
  rawTranscript: z.string().min(500).max(500000),
  slotTranscripts: z.array(z.object({
    label: z.string().min(1).max(40),
    text: z.string().min(100).max(200000),
  })).optional().default([]),
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
  premise: z.string().default(""),
  sections: z.array(SectionSchema).default([]),
});

const SlotChapterSchema = z.object({
  title: z.string().default(""),
  premise: z.string().default(""),
  sections: z.array(SectionSchema).default([]),
});

const SlotChapterBlueprintSchema = z.object({
  title: z.string().default(""),
  premise: z.string().default(""),
  argumentArc: z.string().default(""),
  sections: z.array(z.object({
    sectionNumber: z.number().int().positive(),
    heading: z.string().default(""),
    movement: z.string().default(""),
    coveredBlockIds: z.array(z.string()).optional().default([]),
    storyPlacement: z.string().optional().default(""),
    plannedKeyClaims: z.array(z.string()).optional().default([]),
    targetWords: z.number().int().optional(),
  })).default([]),
});

const BLUEPRINT_SYSTEM = `You are the structural architect for a bestselling nonfiction book. Plan ONE chapter from a sermon transcript slot before any prose is written.

Produce a blueprint with:
- title: 4-7 words, punchy, complete phrase
- premise: 1-2 sentences — the chapter's core burden
- argumentArc: 2-3 sentences tracing how the chapter moves from its opening burden to its final resolution
- sections: the full section map. For each section:
  - heading: 4-8 words, complete phrase, never a generic label
  - movement: 1-2 sentences — the NEW movement this section contributes (not a summary of the chapter)
  - coveredBlockIds: which significant teaching blocks this section owns
  - storyPlacement: the live example/story from the source that lands here, or "" if none
  - plannedKeyClaims: 2-4 specific claims this section will develop
  - targetWords: 700-1200 when the material supports it

PLANNING RULES:
- Every teaching block must be owned by exactly one section.
- A story appears in exactly one section.
- The first section that develops a concept owns it; later sections must plan NEW movement.
- Only section 1 may open the chapter; sections 2+ must plan direct continuation.
- The final section must plan closure without a recap list.
- Ground everything in the transcript. Plan nothing the source does not support.`;

function formatSlotBlueprint(b: z.infer<typeof SlotChapterBlueprintSchema>): string {
  const sectionLines = b.sections.map((s) => [
    `  Section ${s.sectionNumber}: "${s.heading}"${s.targetWords ? ` (~${s.targetWords} words)` : ""}`,
    `    Movement: ${s.movement}`,
    (s.coveredBlockIds ?? []).length ? `    Owns blocks: ${s.coveredBlockIds.join(", ")}` : "",
    s.storyPlacement ? `    Story: ${s.storyPlacement}` : "",
    (s.plannedKeyClaims ?? []).length ? `    Claims: ${s.plannedKeyClaims.join(" | ")}` : "",
  ].filter(Boolean).join("\n"));
  return [
    "CHAPTER BLUEPRINT (BINDING — follow this plan exactly):",
    `Title: ${b.title}`,
    `Premise: ${b.premise}`,
    `Argument arc: ${b.argumentArc}`,
    ...sectionLines,
  ].join("\n");
}

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

function cleanGeneratedBody(text: string): string {
  return stripAudienceLanguage(text)
    .replace(/\b(say amen|turn to your neighbor|lift your hands|clap your hands|can i get an amen|shout hallelujah)\b/gi, "")
    .replace(/\b(good morning church|good evening church|thank you for coming|welcome everyone)\b/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function clampTranscript(text: string, maxChars = 140000): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, Math.floor(maxChars * 0.6));
  const tail = text.slice(-Math.floor(maxChars * 0.4));
  return `${head}\n\n[... transcript middle omitted for length ...]\n\n${tail}`;
}

function clampSlotTranscript(text: string, maxChars = 22000): string {
  if (text.length <= maxChars) return text;
  const headChars = Math.floor(maxChars * 0.4);
  const middleChars = Math.floor(maxChars * 0.25);
  const tailChars = maxChars - headChars - middleChars;
  const midStart = Math.max(0, Math.floor((text.length - middleChars) / 2));
  const head = text.slice(0, headChars);
  const middle = text.slice(midStart, midStart + middleChars);
  const tail = text.slice(-tailChars);
  return `${head}\n\n[... slot transcript middle sample ...]\n\n${middle}\n\n[... slot transcript tail sample ...]\n\n${tail}`;
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
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
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
            body: cleanGeneratedBody(section.body || ""),
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
    premise: (object.premise || "").trim(),
    sections: (object.sections ?? [])
      .filter((section) => (section.body || "").trim().length > 0)
      .map((section, sectionIndex) => ({
        ...section,
        sectionNumber: sectionIndex + 1,
        heading: (section.heading || `Section ${sectionIndex + 1}`).trim(),
        body: cleanGeneratedBody(section.body || ""),
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
  const reasoningTemperature = input.llmTemperature ?? getEbookTemperature(eBookModel, "reasoning");

  const slotBlocks = (input.slotTranscripts ?? [])
    .filter((slot) => slot.text.trim().length > 0)
    .map((slot, idx) => {
      const sourceId = `audio-${idx + 1}`;
      return {
        sourceId,
        label: slot.label,
        fullText: slot.text,
        text: slot.text,
      };
    });

  const usingSlots = input.oneChapterPerSlot && slotBlocks.length > 0;
  const transcriptForPrompt = usingSlots
    ? ""
    : clampTranscript(input.rawTranscript, 160000);
  // deepseek-reasoner counts CoT + output tokens together under max_tokens;
  // keep headroom so deep reasoning never compresses or truncates the prose.
  const maxTokens = usingSlots ? 32000 : 48000;

  const system = `You are a bestselling nonfiction ghostwriter commissioned to transform sermon transcripts into a premium, publication-ready book manuscript. Write with the full depth, craft, and authority of a professionally published book.

FIVE GOVERNING PRINCIPLES:

1) GROUNDING. Every sentence must be traceable to the transcript. Never invent ideas, examples, facts, statistics, or theology. Rewrite into polished, publication-ready prose — never paste transcript blocks verbatim.

2) DEPTH. Develop every argument fully. Target 700-1200 words per section when the material supports it, so each chapter lands around 3500-4500 words. Write until each section's movement is complete. Thoroughness is mandatory: cover the full transcript and all significant teaching blocks, not just highlights. If the material on a point is thin, write what it supports with excellence and move on — never pad with filler.

3) ARCHITECTURE. Section count is content-driven: use as many sections as clear flow and full coverage require. Chapter titles: 4-7 words, punchy, complete phrases. Section headings: 4-8 words, complete phrases, never dangling, never generic labels like Introduction, Overview, Summary, or Conclusion. Keep chronological integrity unless a minimal reorder improves clarity.

4) NO DUPLICATION. The first section that develops a concept owns it. Later sections may reference it in one short clause only; they must contribute new movement, not re-development. Never retell a full story in multiple sections — reference it briefly and move forward.

5) FLOW. Only section 1 may open with a short chapter-orientation paragraph (60-110 words) that lands the reader in the chapter's core burden. Sections 2+ continue the argument directly — no re-introductions, no thesis re-framing, no opening-hook echoes. Every non-final section ends with forward pull from its own content: an unresolved tension, implication, contrast, or hinge statement (a question is optional); never recap phrasing. Only the final section delivers closure, without re-listing prior section points.

PROSE CRAFT:
- Preserve scripture fidelity and render scripture with premium readability.
- Preserve and integrate the speaker's live examples and stories: keep setup, tension, and payoff in order, attached to the section's argument. Draw the teaching implication at the story's turning point, then move forward.
- Remove all pulpit and live-audience language from narration (e.g. "say amen", "turn to your neighbor", "lift your hands", "good morning church").
- Output valid JSON only.

GOLD STANDARD — match this depth, rhythm, and authority in every section (craft benchmark only; never reuse its subject matter):

"Faith is not the absence of fear; it is the decision to move while fear is still in the room. When Peter stepped out of the boat, the wind did not stop. The waves did not lie down. Scripture is careful to tell us that he saw the wind — which means the storm was still raging while he walked on the water. That is the detail most of us skip. We wait for conditions to improve before we obey, but obedience in the kingdom rarely waits for calm seas. It answers the voice first and negotiates with the weather later.

Notice what the story does not say. It does not say Peter felt ready. It does not say the other disciples cheered him on. They stayed in the boat — eleven competent men holding on to the only thing that looked safe. And that is where many believers quietly live: competent, cautious, and dry, watching someone else do the very thing they were all invited to do.

So the question is never whether the storm is real. The storm is real. The question is whether His voice carries more weight than the wind."

AUTHOR CONFIGURATION POLICY:
- Treat TARGET AUDIENCE and AUTHOR INSTRUCTIONS as high-priority presentation directives.
- Apply them to voice, structure, emphasis, pacing, framing, and reader experience across the manuscript.
- These directives never permit source invention. If an instruction requires facts not present in transcript material, keep source fidelity and write less.

${SOURCE_LOCK_RULES}`;

  const chapterRoutingBlock = usingSlots
    ? `CHAPTER-SLOT ASSIGNMENT (HARD RULE):
- Create EXACTLY ${slotBlocks.length} chapters.
- Create exactly ONE chapter per slot.
- Chapter 1 must use only audio-1, Chapter 2 only audio-2, and so on.
- Never mix content from different source slots in the same chapter.
- If a slot is thin, still keep one chapter and deepen commentary from that slot only.`
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

  const jsonTemplate = `{
  "bookTitle": "...",
  "subtitle": "...",
  "authorName": "the Author",
  "strategy": "single-pass-sermon-style",
  "chapters": [
    {
      "number": 1,
      "title": "...",
      "premise": "...",
      "sections": [
        {
          "sectionNumber": 1,
          "heading": "...",
          "body": "...",
          "keyClaims": ["..."]
        }
      ]
    }
  ]
}`;

  const slotChapterTemplate = `{
  "title": "...",
  "premise": "...",
  "sections": [
    {
      "sectionNumber": 1,
      "heading": "...",
      "body": "...",
      "keyClaims": ["..."],
      "coveredBlockIds": ["B1", "B2"]
    }
  ]
}`;

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

        // ── Pass 1: blueprint ────────────────────────────────────────────
        // A dedicated reasoning pass maps the argument arc, section movements,
        // block ownership, and story placement BEFORE any prose is written, so
        // the write pass drafts against a plan instead of planning and drafting
        // in one constrained shot.
        let blueprintSection = "";
        try {
          const { object: blueprint } = await generateObject({
            model: getEbookModel(eBookModel),
            schema: SlotChapterBlueprintSchema,
            schemaName: "ChapterBlueprint",
            schemaDescription: "Structural plan for one chapter: argument arc, section map, block ownership, story placement",
            mode: "json",
            temperature: reasoningTemperature,
            maxTokens: 8000,
            system: BLUEPRINT_SYSTEM,
            prompt: [
              `Plan ONE complete chapter from SOURCE SLOT ${chapterNumber}.`,
              "",
              `CHAPTER NUMBER: ${chapterNumber}`,
              `TARGET AUDIENCE: ${input.targetAudience || "(not provided)"}`,
              `CORE THESIS: ${input.coreThesis || "(not provided)"}`,
              `VOICE TONE: ${input.voiceTone || "(not provided)"}`,
              `AUTHOR INSTRUCTIONS: ${input.authorInstructions || "(not provided)"}`,
              "",
              "SIGNIFICANT TEACHING BLOCKS (every block must be owned by exactly one planned section):",
              teachingBlockManifest,
              "",
              "SOURCE SLOT TRANSCRIPT:",
              slot.text,
            ].join("\n"),
          });
          if (blueprint.sections.length > 0) {
            blueprintSection = `${formatSlotBlueprint(blueprint)}\n\nBLUEPRINT DISCIPLINE (HARD RULE):\n- Follow the blueprint exactly: same section order, headings, block ownership, and story placement.\n- Write each section's full prose to deliver its planned movement and claims.\n- Deviate from the blueprint only where it contradicts source grounding.`;
          }
        } catch {
          // Blueprint is an accelerator, not a hard dependency: on failure,
          // fall through to direct single-pass writing.
        }

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

TEACHING BLOCK COVERAGE CONTRACT (HARD REQUIREMENT):
- Every significant teaching block listed below must be covered in this chapter.
- Each section must declare coveredBlockIds.
- No block may be skipped.
- You may cover multiple blocks in one section when naturally related.

SIGNIFICANT TEACHING BLOCKS:
${teachingBlockManifest}

${storyIntegrationBlock}

${blueprintSection}

SCRIPTURE FORMATTING:
${SCRIPTURE_FORMATTING_RULES}

SECTION FLOW AND BOUNDARIES (HARD REQUIREMENTS):
- Section 1 only: begin with one short chapter-orientation opener paragraph (about 60-110 words) that lands the reader in the chapter burden.
- Sections 2+: do not re-introduce chapter context, thesis framing, or opening-hook phrasing from section 1.
- Non-final sections must end with one forward-driving bridge rooted in that section's own material (question optional).
- Never end a non-final section with recap phrasing (forbidden examples: "In summary...", "So we see...", "This section showed...").
- Do not preview or summarize the next section's content.
- The final section may close the chapter, but must not re-list prior section points as a summary paragraph.

SOURCE SLOT:
SOURCE ID: ${slot.sourceId}
LABEL: ${slot.label}
TRANSCRIPT:
${slot.text}${priorClaimsBlock}`;

        let chapterObject: z.infer<typeof SlotChapterSchema> | null = null;

        for (let attempt = 0; attempt < 3; attempt++) {
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
          } catch {
            // Try text-mode JSON salvage pass below.
          }
        }

        if (!chapterObject) {
          try {
            const { text } = await generateText({
              model: getEbookModel(eBookModel),
              temperature: reasoningTemperature,
              maxTokens,
              system,
              prompt: `${slotPrompt}\n\nReturn ONLY JSON in this exact shape:\n${slotChapterTemplate}`,
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
          } catch {
            // No local fallback: fail closed if model output cannot be parsed.
          }
        }

        if (!chapterObject) {
          return NextResponse.json(
            { error: `Simple book generation failed: slot ${chapterNumber} did not return valid chapter JSON` },
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

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { object } = await generateObject({
          model: deepSeekReasonerModel,
          schema: SimpleBookSchema,
          mode: "json",
          temperature: reasoningTemperature,
          maxTokens,
          system,
          prompt: `${prompt}\n\n${storyIntegrationBlock}`,
        });
        const normalized = normalizeSimpleBook(object, input);
        if (normalized.chapters.length > 0) {
          return NextResponse.json(normalized);
        }
      } catch {
        // Fall through to next attempt or fallback text mode.
      }
    }

    const { text } = await generateText({
      model: deepSeekReasonerModel,
      temperature: reasoningTemperature,
      maxTokens,
      system,
      prompt: `${prompt}\n\n${storyIntegrationBlock}\n\nReturn ONLY JSON in this exact shape:\n${jsonTemplate}`,
    });

    const json = extractFirstJsonObject(text);
    if (!json) {
      return NextResponse.json(
        { error: "Simple book generation failed: model did not return parseable JSON" },
        { status: 502 }
      );
    }

    const parsed = SimpleBookSchema.safeParse(JSON.parse(json));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Simple book generation failed: JSON shape invalid", details: parsed.error.issues.slice(0, 5) },
        { status: 502 }
      );
    }

    const normalized = normalizeSimpleBook(parsed.data, input);
    if (normalized.chapters.length === 0) {
      return NextResponse.json(
        { error: "Simple book generation failed: no chapter content returned" },
        { status: 502 }
      );
    }

    return NextResponse.json(normalized);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Simple book generation failed" },
      { status: 500 }
    );
  }
}
