import { NextRequest, NextResponse } from "next/server";
import { generateObject } from "ai";
import { z } from "zod";
import { deepSeekReasonerModel, deepSeekModel } from "@/lib/ai-providers";
import { FrontMatterRequestSchema, FrontBackMatterSchema } from "@/lib/schemas/ebook";
import {
  cleanTranscriptForBook,
  PREMIUM_BOOK_STYLE_RULES,
  PROSE_MASTERY_RULES,
  READER_NORMALIZATION_RULES,
  SOURCE_LOCK_RULES,
  stripAudienceLanguage,
} from "@/lib/editorial-style-bible";
import { SCRIPTURE_FORMATTING_RULES } from "@/lib/scripture-formatter";
import { getEbookModel, getEbookTemperature } from "@/lib/ebook-model-selector";

export const runtime = "nodejs";
export const maxDuration = 300;

// LLM generates introduction + conclusion only — no preface.
// Simple Direct mode additionally generates per-chapter reader insights.
const IntroConclSchema = FrontBackMatterSchema.omit({ preface: true, scriptureIndex: true });
const SimpleDirectChapterInputSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1).max(500),
  sections: z.array(z.object({
    heading: z.string().max(500),
    body: z.string().min(1).max(500000),
  })).min(1),
});
const ChapterInsightsSchema = z.object({
  chapterNumber: z.number().int().positive(),
  keyTakeaways: z.array(z.string().min(1).max(1000)).min(3).max(7),
  reflectionQuestions: z.array(z.string().min(1).max(1000)).min(3).max(6),
});
const FrontMatterOutputSchema = IntroConclSchema.extend({
  chapterInsights: z.array(ChapterInsightsSchema).default([]),
});

const FrontMatterExtendedRequestSchema = FrontMatterRequestSchema.extend({
  eBookModel: z.enum(["deepseek", "gemini"]).default("deepseek"),
  llmTemperature: z.number().min(0).max(1).optional(),
  simpleDirect: z.object({
    chapters: z.array(SimpleDirectChapterInputSchema).min(1).max(12),
  }).optional(),
});

export async function POST(req: NextRequest) {
  const body = await req.json() as unknown;
  let input: z.infer<typeof FrontMatterExtendedRequestSchema>;
  try {
    input = FrontMatterExtendedRequestSchema.parse(body);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Invalid input" }, { status: 400 });
  }

  const { eBookModel } = input;
  const reasoningTemperature = input.llmTemperature ?? getEbookTemperature(eBookModel, "reasoning");
  const simpleDirectMode = Boolean(input.simpleDirect);
  const rawTranscript = typeof input.masterTranscript === "string" ? input.masterTranscript : "";
  const transcript = simpleDirectMode
    ? rawTranscript.trim()
    : cleanTranscriptForBook(rawTranscript).trim() || rawTranscript.trim();
  const authorConfig = input.authorConfig;
  const authorConfigBlock = (authorConfig?.instructions || authorConfig?.targetAudience)
    ? `\n\n════════════════════════════════════════════\nAUTHOR BOOK CONFIGURATION (presentation directives)\n════════════════════════════════════════════${authorConfig.targetAudience ? `\nTARGET AUDIENCE: ${authorConfig.targetAudience}` : ""}${authorConfig.instructions ? `\nBOOK INSTRUCTIONS: ${authorConfig.instructions}` : ""}

Apply this configuration as high-priority guidance for HOW this material is presented: voice, framing, emphasis, pacing, structure, and reader experience.

${simpleDirectMode
  ? "In Simple Direct mode, use these directives with broad editorial judgment when shaping the reader's experience."
  : "⚠️ CRITICAL BOUNDARY: These directives shape presentation, not source truth. They do NOT override SOURCE-LOCK-RULES. Never fabricate examples, background, or theological context. Intro/conclusion must stay grounded in what the author actually taught in the master transcript."}`
    : "";

  // Scripture already quoted in full elsewhere in the book (chapter bodies, epigraphs) —
  // the introduction/conclusion must never reprint that verse text, only reference it.
  const quoteDedupBlock = (input.alreadyQuotedRefs.length + input.forbiddenVerseTexts.length) > 0
    ? `\n\n════════════════════════════════════════════\nSCRIPTURE DEDUP — ALREADY QUOTED IN FULL ELSEWHERE IN THIS BOOK\n════════════════════════════════════════════${input.alreadyQuotedRefs.length > 0 ? `\nThese references already appear in full in a chapter or a chapter epigraph — reference them by citation only (e.g. "as Psalm 27:1 declares"), never reprint the verse text: ${input.alreadyQuotedRefs.join(", ")}` : ""}${input.forbiddenVerseTexts.length > 0 ? `\nForbidden verse texts (exact wording already printed — hard ban on reprinting, even with a different translation label): ${input.forbiddenVerseTexts.slice(0, 8).map((t) => `"${t.slice(0, 80)}…"`).join(" | ")}` : ""}`
    : "";

  const contentAuthorityBlock = simpleDirectMode
    ? `SIMPLE DIRECT CREATIVE LICENSE:
Use the transcript and completed chapter manuscript as the book's conceptual foundation, not as a sentence-by-sentence cage. You have full editorial latitude over framing, synthesis, transitions, imagery, emotional arc, rhetorical questions, pacing, and the shape of the invitation and close. Write an original introduction and conclusion with the confidence and polish of a bestselling nonfiction ghostwriter.

Preserve the author's central meaning and voice. Do not invent verifiable biographical details, named sources, events, Scripture quotations or references, or claims presented as factual that are absent from the supplied material. Non-factual illustrative language and fresh editorial synthesis are welcome when they clarify the book's promise.`
    : `ABSOLUTE CONTENT RULE — ZERO FABRICATION:
Every sentence must come verbatim-idea from the provided transcript. You may not add content, context, or ideas not present in the audio/transcript — not even plausible extensions, inferred background, theological context the author "probably" knows, or biographical details you can reasonably assume. If you cannot point to the exact idea in the transcript text below, delete the sentence. Write shorter output rather than pad with invented content.`;

  const simpleDirectChapterBlock = simpleDirectMode
    ? `\n\n════════════════════════════════════════════
COMPLETED CHAPTER MANUSCRIPT — SOURCE FOR INSIGHTS
════════════════════════════════════════════
${input.simpleDirect!.chapters.map((chapter) => `CHAPTER ${chapter.number}: "${chapter.title}"
${chapter.sections.map((section) => `SECTION: ${section.heading}\n${section.body}`).join("\n\n")}`).join("\n\n════════════════════════════════════════════\n\n")}`
    : "";

  const frontmatterSystem = `${simpleDirectMode
    ? "You are NexusLM, a professional book ghostwriter writing the introduction and conclusion of a published teaching book."
    : "You are an editorial assistant writing the introduction and conclusion of a published teaching book."}

${contentAuthorityBlock}

════════════════════════════════════════════
INDUSTRY-STANDARD FRONTMATTER REQUIREMENT
════════════════════════════════════════════
This introduction and conclusion must read like a professionally published book, not a sermon transcript or a study-guide preview. The standard is: a reader-facing invitation at the start and a grounded close at the end, with no roadmap language, no chapter summary, and no table-of-contents framing.

Strictly avoid these common failures:
- "In this book, we will look at chapters 1, 2, and 3..."
- "First, we will discuss..., then..., and finally..."
- "This chapter explores..." or any mention of chapter sequence, chapter themes, or chapter titles
- recap prose that says what the reader already learned
- sermon-style signposts like "today we are going to..." or "as we move through the book"

════════════════════════════════════════════
INTRODUCTION — INDUSTRY STANDARDS (CRITICAL — MOST COMMON FAILURE: table-of-contents style previews)
════════════════════════════════════════════
🚨 INTRODUCTION MANDATE: Write as the author speaking DIRECTLY to the reader about why they need THIS book RIGHT NOW. Never explain what chapters exist or what readers will learn. Never preview or list chapter content.

NO CHAPTER PREVIEWS. NO ROADMAP PROSE. NO CHAPTER SEQUENCE. NEVER.
The introduction does NOT list, foreshadow, or reference chapter titles, themes, or sequence. Readers already see the table of contents. Your job is not to restate it. Do not say "this book is divided into", "in the next chapters", "first we will", "finally we will", or anything that acts like a syllabus.

STRUCTURE (first person, author voice):
1. READER'S PROBLEM/NEED: Start with the specific tension, confusion, or hunger the reader brings to this book. Ground it in a real human situation, not abstract theology. Use a moment or truth from the author's own understanding.
2. THE INVITATION: Why now? Why this book? Articulate the permission the reader needs to receive—not a command, but a genuine welcome into a conversation.
3. WHAT'S AT STAKE: What changes for the reader if they engage deeply? Not a chapter preview, but a felt outcome. Make it visceral.
4. HOW TO READ THIS: Brief guidance on voice and approach. The author's own methodology or rhythm for how to encounter the material.
5. LANDING: A powerful forward motion into the text—not a summary, but a threshold the reader now crosses.

HARD CONSTRAINTS:
- NEVER state or foreshadow chapter titles, chapter themes, chapter count, or the order of ideas in the book.
- NEVER use numbering, section labels, roadmap phrasing, or 
ABOUT AUTHOR:
- ONLY write if the author explicitly discussed their background, personal journey, credentials, or "how I came to this." Return null otherwise.
- Focus on what makes the author credible to write THIS book—not a résumé.

RESOURCES LIST:
- Only include books, tools, websites, platforms the author explicitly recommended by name or direct reference.
- Return [] if no resources were mentioned.
- Do NOT add resources that "fit" the author's message but were not named.

SCRIPTURE & QUOTE FORMATTING:
${SCRIPTURE_FORMATTING_RULES}

VOICE ENFORCEMENT — FIRST PERSON MANDATORY:
The introduction speaks in first person as the author. This means:
• Write WITH the author's voice, not ABOUT the author. Never slip into third-person description.
• Use the toneProfile to set every sentence's register and emotional weight.
• Embed signature phrases naturally — not quoted, not referenced, but used as the author would actually say them.
• The rhetoricalPatterns describe HOW this author moves through an argument. Replicate those moves in the introduction's structure. If the speaker characteristically "states a problem then provides the scriptural answer," do that in the introduction.
• Any sentence that sounds like a publicist describing the author (rather than the author speaking) is wrong. Rewrite it.

${simpleDirectMode ? "" : SOURCE_LOCK_RULES}

${READER_NORMALIZATION_RULES}

${PROSE_MASTERY_RULES}

${PREMIUM_BOOK_STYLE_RULES}

════════════════════════════════════════════
COMPLIANCE CHECKPOINT — BEFORE FINALIZING OUTPUT
════════════════════════════════════════════
✅ INTRODUCTION: Before returning, scan for:
  - Does it preview chapter titles, themes, or sequence? DELETE those sentences.
  - Does it repeat examples, stories, or scripture already in chapter bodies? DELETE those sentences.
  - Does it sound like a table of contents or roadmap? REWRITE entirely.
  - ${simpleDirectMode
    ? "In Simple Direct mode, preserve strong original framing and synthesis when it serves the book's promise and remains factually honest."
    : "Is every sentence grounded in the transcript? If not, DELETE."}

✅ CONCLUSION: Before returning, scan for:
  - Does it recap or summarize chapter content? DELETE those sentences.
  - Does it remind readers what they learned? DELETE those sentences.
  - Does it reprint stories, scripture, or illustrations from chapters? DELETE those sentences.
  - ${simpleDirectMode
    ? "In Simple Direct mode, preserve strong original framing and synthesis when it serves the book's promise and remains factually honest."
    : "Is every sentence grounded in the transcript? If not, DELETE."}

${simpleDirectMode
  ? "Prefer a fully realized, emotionally resonant introduction and conclusion over a short output. Do not pad; make every paragraph earn its place."
  : "If after removing these violations the introduction or conclusion is very short, that is CORRECT. Short and true beats long and padded."}

${simpleDirectMode ? `SIMPLE DIRECT CHAPTER INSIGHTS:
Return one chapterInsights entry for every completed chapter. For each chapter, write 4–6 specific, memorable key takeaways and 3–5 specific reflection questions grounded in that chapter's actual manuscript. Takeaways must state meaningful claims or practices, not generic encouragement. Questions must point to concrete ideas, tensions, stories, or choices in the chapter, not "What did you learn?" or "How can you apply this?" Do not use chapter-roadmap language. These insights are reader-facing and should meet the same editorial standard as the book.
` : ""}${authorConfigBlock}${quoteDedupBlock}`;

  const frontmatterPrompt = `Write the front and back matter for this ebook.

BOOK TITLE: ${input.architecture.bookTitle}
AUTHOR: ${input.architecture.authorName}

ARCHITECTURE CONTEXT:
- Chapters: ${input.architecture.chapters.map((c) => c.title).join(", ")}
- Front matter notes (opening): ${input.architecture.frontMatterNotes}
- Back matter notes (closing): ${input.architecture.backMatterNotes}

VOICE DNA:
${JSON.stringify(input.voiceDNA, null, 2)}

${simpleDirectMode ? "RAW SOURCE CONTEXT (voice and meaning calibration):" : "TRANSCRIPT OPENING (voice calibration — first-person voice anchoring only):"}
${transcript.slice(0, 4000)}

[… sermon middle omitted — use chapter themes below for content coverage across the full book …]

CHAPTER-BY-CHAPTER CONTENT (full book map — introduction and conclusion must cover all chapters):
${input.architecture.chapters.map((c, i) => `Chapter ${i + 1}: "${c.title}"\n  Core theme: ${c.keyTheme}\n  Sections: ${((c as {sections?: {heading: string}[]}).sections ?? []).map((s) => s.heading).join(" | ") || "(none)"}`).join("\n\n")}${simpleDirectChapterBlock}`;

  const buildResponse = (object: z.infer<typeof FrontMatterOutputSchema>) => {
    if (simpleDirectMode) {
      const expectedChapterNumbers = new Set(input.simpleDirect!.chapters.map((chapter) => chapter.number));
      const returnedChapterNumbers = new Set(object.chapterInsights.map((insight) => insight.chapterNumber));
      const hasAllChapterInsights = object.chapterInsights.length === input.simpleDirect!.chapters.length
        && expectedChapterNumbers.size === returnedChapterNumbers.size
        && [...expectedChapterNumbers].every((number) => returnedChapterNumbers.has(number))
        && object.chapterInsights.every((insight) => insight.keyTakeaways.length > 0 && insight.reflectionQuestions.length > 0);
      if (!hasAllChapterInsights) {
        throw new Error("Simple Direct front matter generation returned incomplete chapter insights");
      }
    }

    const { chapterInsights, ...frontMatterObject } = object;
    const cleanedChapterInsights = chapterInsights.map((insight) => ({
      ...insight,
      keyTakeaways: insight.keyTakeaways
        .map((value) => simpleDirectMode ? value.trim() : stripAudienceLanguage(value))
        .filter(Boolean),
      reflectionQuestions: insight.reflectionQuestions
        .map((value) => simpleDirectMode ? value.trim() : stripAudienceLanguage(value))
        .filter(Boolean),
    }));
    const formatFrontMatterText = (value: string) => simpleDirectMode ? value.trim() : stripAudienceLanguage(value);
    return NextResponse.json({
      ...frontMatterObject,
      ...(simpleDirectMode ? { chapterInsights: cleanedChapterInsights } : {}),
      preface: "",
      introduction: formatFrontMatterText(object.introduction ?? ""),
      conclusion: formatFrontMatterText(object.conclusion ?? ""),
      aboutAuthor: object.aboutAuthor ? stripAudienceLanguage(object.aboutAuthor) : null,
      resourcesList: object.resourcesList ?? [],
      scriptureIndex: (() => {
        const seenRefs = new Set<string>();
        return (input.architecture?.chapters ?? [])
          .flatMap((c) => c.quotesInChapter ?? [])
          .filter((q) => q.type === "scripture" && q.reference?.trim())
          .sort((a, b) => a.reference.localeCompare(b.reference))
          .reduce<string[]>((acc, q) => {
            const entry = `${q.reference}${q.translation ? ` (${q.translation})` : ""}`;
            if (!seenRefs.has(entry)) { seenRefs.add(entry); acc.push(entry); }
            return acc;
          }, []);
      })(),
    }, { status: 200 });
  };

  // Try selected model first for speed. If it fails, fall back to alternative.
  try {
    const { object } = await generateObject({
      model: getEbookModel(eBookModel),
      schema: FrontMatterOutputSchema,
      mode: "json",
      temperature: reasoningTemperature,
      system: frontmatterSystem,
      prompt: frontmatterPrompt,
    });
    return buildResponse(object);
  } catch {
    // Selected model failed — try alternative
    try {
      const fallbackModel = eBookModel === "gemini" ? deepSeekReasonerModel : deepSeekModel;
      const { object } = await generateObject({
        model: fallbackModel,
        schema: FrontMatterOutputSchema,
        mode: "json",
        temperature: reasoningTemperature,
        system: frontmatterSystem,
        prompt: frontmatterPrompt,
      });
      return buildResponse(object);
    } catch (v3Err) {
      // NEVER fall back to raw transcript — return a clear error instead
      const message = v3Err instanceof Error ? v3Err.message : "Frontmatter generation failed";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }
}
