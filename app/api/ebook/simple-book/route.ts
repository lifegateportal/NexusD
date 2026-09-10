import { NextRequest, NextResponse } from "next/server";
import { generateObject, generateText } from "ai";
import { z } from "zod";
import { deepSeekReasonerModel } from "@/lib/ai-providers";
import { SOURCE_LOCK_RULES, stripAudienceLanguage } from "@/lib/editorial-style-bible";
import { SCRIPTURE_FORMATTING_RULES } from "@/lib/scripture-formatter";

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
  previousChapterSummary: z.string().max(4000).optional().default(""),
  chapterNumber: z.number().int().min(1).max(30).optional(),
  totalChapters: z.number().int().min(1).max(30).optional(),
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
  keyTakeaways: z.array(z.string()).default([]),
  reflectionQuestions: z.array(z.string()).default([]),
  sections: z.array(SectionSchema).default([]),
});

const SlotChapterSchema = z.object({
  title: z.string().default(""),
  premise: z.string().default(""),
  keyTakeaways: z.array(z.string()).default([]),
  reflectionQuestions: z.array(z.string()).default([]),
  sections: z.array(SectionSchema).default([]),
});

const SimpleBookSchema = z.object({
  bookTitle: z.string().default("Untitled"),
  subtitle: z.string().default(""),
  authorName: z.string().default("the Author"),
  strategy: z.string().default("single-pass-sermon-style"),
  chapters: z.array(ChapterSchema).default([]),
});

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
    .replace(/\b(in this chapter we will explore|let us now turn our attention to|it is important to note that|as we can clearly see)\b/gi, "")
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
  const head = text.slice(0, Math.floor(maxChars * 0.65));
  const tail = text.slice(-Math.floor(maxChars * 0.35));
  return `${head}\n\n[... slot transcript middle omitted for length ...]\n\n${tail}`;
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

function buildTeachingBlocks(text: string, maxBlocks = 18): TeachingBlock[] {
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
    if (currentWords >= targetWordsPerBlock && chunks.length < maxBlocks - 1) {
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

  const sampled = chunks.slice(0, maxBlocks).map((chunk, idx) => ({
    id: `B${idx + 1}`,
    wordCount: countWords(chunk),
    excerpt: chunk.slice(0, 360),
  }));

  return sampled;
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
        keyTakeaways: (chapter.keyTakeaways ?? []).map((s) => cleanGeneratedBody(s)).filter(Boolean),
        reflectionQuestions: (chapter.reflectionQuestions ?? []).map((s) => cleanGeneratedBody(s)).filter(Boolean),
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

function normalizeSlotChapter(object: z.infer<typeof SlotChapterSchema>, chapterNumber: number): z.infer<typeof ChapterSchema> {
  return {
    number: chapterNumber,
    title: (object.title || `Chapter ${chapterNumber}`).trim(),
    premise: (object.premise || "").trim(),
    keyTakeaways: (object.keyTakeaways ?? []).map((s) => cleanGeneratedBody(s)).filter(Boolean),
    reflectionQuestions: (object.reflectionQuestions ?? []).map((s) => cleanGeneratedBody(s)).filter(Boolean),
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

function sentenceChunks(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function pickChapterTitle(label: string, text: string, chapterNumber: number): string {
  const cleanLabel = label.replace(/^slot-?/i, "").trim();
  if (cleanLabel.length >= 4) return cleanLabel.slice(0, 72);
  const firstLine = text.split(/\n+/).map((s) => s.trim()).find((s) => s.length >= 8) || "";
  if (firstLine) return firstLine.split(/[.!?]/)[0].slice(0, 72);
  return `Chapter ${chapterNumber}`;
}

function buildFallbackSlotChapter(
  slot: { label: string; text: string },
  chapterNumber: number,
  targetAudience: string,
): z.infer<typeof ChapterSchema> {
  const sentences = sentenceChunks(slot.text);
  const sectionCount = Math.max(3, Math.min(12, Math.ceil(sentences.length / 8)));
  const bucketSize = Math.max(4, Math.ceil(sentences.length / sectionCount));
  const sections = Array.from({ length: sectionCount }, (_v, i) => {
    const start = i * bucketSize;
    const end = Math.min(sentences.length, start + bucketSize);
    const slice = sentences.slice(start, end);
    const headingSeed = slice[0] || `Core movement ${i + 1}`;
    const heading = headingSeed.split(/[,:;.!?]/)[0].trim().split(/\s+/).slice(0, 7).join(" ") || `Core movement ${i + 1}`;
    const body = cleanGeneratedBody(slice.join(" ").trim());
    return {
      sectionNumber: i + 1,
      heading,
      body,
      keyClaims: body
        .split(/(?<=[.!?])\s+/)
        .slice(0, 2)
        .map((s) => s.trim())
        .filter((s) => s.length > 20),
    };
  }).filter((section) => section.body.length > 0);

  const chapterTitle = pickChapterTitle(slot.label, slot.text, chapterNumber);
  const premise = targetAudience.trim()
    ? `This chapter applies the sermon's teaching to ${targetAudience.trim()}.`
    : "This chapter develops the sermon's core teaching with grounded examples and application.";

  const keyTakeaways = sections
    .map((section) => (section.keyClaims ?? [])[0])
    .filter((s): s is string => Boolean(s && s.trim()))
    .slice(0, 6);

  const reflectionQuestions = keyTakeaways
    .slice(0, 4)
    .map((claim) => `How does this claim challenge your current practice: ${claim}?`);

  return {
    number: chapterNumber,
    title: chapterTitle,
    premise,
    keyTakeaways,
    reflectionQuestions,
    sections,
  };
}

function chapterHandoffSummary(chapter: z.infer<typeof ChapterSchema>): string {
  const title = (chapter.title || "").trim();
  const claims = (chapter.sections ?? [])
    .flatMap((section) => section.keyClaims ?? [])
    .map((claim) => claim.trim())
    .filter(Boolean)
    .slice(0, 2);

  if (claims.length >= 2) {
    return `${claims[0]} ${claims[1]}`.replace(/\s+/g, " ").trim();
  }

  const bodies = (chapter.sections ?? [])
    .map((section) => section.body || "")
    .join(" ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 25)
    .slice(0, 2);

  if (bodies.length > 0) return bodies.join(" ");
  return title ? `The previous chapter established ${title.toLowerCase()}.` : "The previous chapter established the core teaching.";
}

function ensureChapterBridge(
  chapter: z.infer<typeof ChapterSchema>,
  previousSummary: string | null,
): z.infer<typeof ChapterSchema> {
  if (!previousSummary || !previousSummary.trim()) return chapter;
  if (!chapter.sections || chapter.sections.length === 0) return chapter;

  const bridge = `Previously: ${previousSummary.trim()} Now we turn to this chapter's focus.`;
  const first = chapter.sections[0];
  const body = (first.body || "").trim();

  // Keep the bridge concise and avoid duplication if already present.
  if (body.toLowerCase().includes("previously:")) return chapter;

  const nextFirst = {
    ...first,
    body: `${bridge}\n\n${body}`.trim(),
  };

  return {
    ...chapter,
    sections: [nextFirst, ...chapter.sections.slice(1)],
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

  const slotBlocks = (input.slotTranscripts ?? [])
    .filter((slot) => slot.text.trim().length > 0)
    .map((slot, idx) => {
      const slotBase = (input.chapterNumber && (input.slotTranscripts?.length ?? 0) === 1) ? input.chapterNumber : 1;
      const sourceId = `audio-${slotBase + idx}`;
      return {
        sourceId,
        label: slot.label,
        fullText: slot.text,
        text: clampSlotTranscript(slot.text, 90000),
      };
    });

  const usingSlots = input.oneChapterPerSlot && slotBlocks.length > 0;
  const transcriptForPrompt = usingSlots
    ? ""
    : clampTranscript(input.rawTranscript, 160000);
  const maxTokens = usingSlots ? 22000 : 24000;

  const system = `You are a bestselling nonfiction ghostwriter commissioned to transform sermon transcripts into a premium, publication-ready book manuscript.

You must produce a clean, publication-ready book draft from sermon transcript material using one deterministic philosophy:
- Simple and direct structure like Sermon Assistant
- Strong chapter titles and section headings
- Zero concept duplication across sections and chapters
- Strict transcript grounding

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
16) Thoroughness is mandatory: cover the full transcript and all significant teaching blocks, not just highlights.
17) Padding is prohibited. No filler paragraphs, no generic transitions, and no repeated motivational lines without new teaching content.
18) In the SAME chapter-generation call, also return chapter-level keyTakeaways (4-7) and reflectionQuestions (4-7) grounded in the chapter content.

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
  "keyTakeaways": ["..."],
  "reflectionQuestions": ["..."],
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
- After each story movement, state the teaching implication in plain terms.
- Do not flatten vivid details that carry emotional force unless they are repetitive noise.`;

  try {
    if (usingSlots && slotBlocks.length > 0) {
      const chapters: z.infer<typeof ChapterSchema>[] = [];
      let allSectionClaims: string[] = [];
      let previousChapterSummary: string | null = (input.previousChapterSummary || "").trim() || null;

      for (let i = 0; i < slotBlocks.length; i++) {
        const slot = slotBlocks[i];
        const chapterNumber = (input.chapterNumber && slotBlocks.length === 1)
          ? input.chapterNumber
          : i + 1;
        const teachingBlocks = buildTeachingBlocks(slot.fullText, 20);
        const teachingBlockManifest = teachingBlocks.length > 0
          ? teachingBlocks.map((b) => `- ${b.id} (${b.wordCount} words): ${b.excerpt}`).join("\n")
          : "- B1: (no extracted block; use full transcript coverage)";
        const priorClaimsBlock = allSectionClaims.length > 0
          ? `\n\nPRIOR CHAPTER CLAIMS (DO NOT REPEAT IN FULL):\n${allSectionClaims.slice(-30).map((c) => `- ${c}`).join("\n")}`
          : "";
        const chapterBridgeBlock = previousChapterSummary
          ? `\n\nCHAPTER BRIDGE REQUIREMENT:\n- Open this chapter with 1-2 short sentences summarizing the previous chapter before launching into the present chapter.\n- Use this previous-chapter summary as the bridge source:\n${previousChapterSummary}`
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

TEACHING BLOCK COVERAGE CONTRACT (HARD REQUIREMENT):
- Every significant teaching block listed below must be covered in this chapter.
- Each section must declare coveredBlockIds.
- No block may be skipped.
- You may cover multiple blocks in one section when naturally related.

SIGNIFICANT TEACHING BLOCKS:
${teachingBlockManifest}

${storyIntegrationBlock}

NO-PADDING RULE:
- Every paragraph must add new teaching value.
- Do not use filler setup language.
- Keep transitions short and meaningful.

CHAPTER WRAP OUTPUT (SAME CALL):
- Return keyTakeaways: 4-7 concise bullets.
- Return reflectionQuestions: 4-7 specific, non-generic questions.
- These must come from this slot chapter only.

SCRIPTURE FORMATTING:
${SCRIPTURE_FORMATTING_RULES}

SOURCE SLOT:
SOURCE ID: ${slot.sourceId}
LABEL: ${slot.label}
TRANSCRIPT:
${slot.text}${priorClaimsBlock}${chapterBridgeBlock}`;

        let chapterObject: z.infer<typeof SlotChapterSchema> | null = null;

        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const { object } = await generateObject({
              model: deepSeekReasonerModel,
              schema: SlotChapterSchema,
              mode: "json",
              temperature: attempt === 0 ? 0.3 : 0.2,
              maxTokens,
              system,
              prompt: slotPrompt,
            });
            chapterObject = object;
            break;
          } catch {
            // Try fallback pass below.
          }
        }

        if (!chapterObject) {
          try {
            const { text } = await generateText({
              model: deepSeekReasonerModel,
              temperature: 0.2,
              maxTokens,
              system,
              prompt: `${slotPrompt}\n\nReturn ONLY JSON in this exact shape:\n${slotChapterTemplate}`,
            });
            const json = extractFirstJsonObject(text);
            if (json) {
              const parsed = SlotChapterSchema.safeParse(JSON.parse(json));
              if (parsed.success) {
                chapterObject = parsed.data;
              }
            }
          } catch {
            // Use deterministic fallback below.
          }
        }

        if (!chapterObject) {
          chapterObject = buildFallbackSlotChapter(slot, chapterNumber, input.targetAudience);
        }

        const normalizedChapter = ensureChapterBridge(
          normalizeSlotChapter(chapterObject, chapterNumber),
          previousChapterSummary
        );
        if (normalizedChapter.sections.length === 0) {
          const fallbackChapter = buildFallbackSlotChapter(slot, chapterNumber, input.targetAudience);
          if (fallbackChapter.sections.length === 0) {
            return NextResponse.json(
              { error: `Simple book generation failed: slot ${chapterNumber} produced no section content` },
              { status: 502 }
            );
          }
          chapters.push(fallbackChapter);
          continue;
        }

        chapters.push(normalizedChapter);
        allSectionClaims = [
          ...allSectionClaims,
          ...normalizedChapter.sections.flatMap((section) => (section.keyClaims ?? []).map((claim) => claim.trim()).filter(Boolean)),
        ];
        previousChapterSummary = chapterHandoffSummary(normalizedChapter);
      }

      const bookFromSlots: z.infer<typeof SimpleBookSchema> = {
        bookTitle: (chapters[0]?.title || "Untitled").trim(),
        subtitle: nonEmptySubtitle(input.targetAudience, input.coreThesis),
        authorName: "the Author",
        strategy: "slot-by-slot-sermon-style",
        chapters,
      };

      const normalizedSlotsBook = normalizeSimpleBook(bookFromSlots, input);
      return NextResponse.json(normalizedSlotsBook);
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { object } = await generateObject({
          model: deepSeekReasonerModel,
          schema: SimpleBookSchema,
          mode: "json",
          temperature: attempt === 0 ? 0.3 : 0.2,
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
      temperature: 0.2,
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
