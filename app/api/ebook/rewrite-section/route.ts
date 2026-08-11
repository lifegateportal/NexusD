import { NextRequest, NextResponse } from "next/server";
import { generateObject, streamText } from "ai";
import { z } from "zod";
import { deepSeekModel } from "@/lib/ai-providers";
import { SectionAssignmentSchema } from "@/lib/schemas/ebook";
import { PREMIUM_BOOK_STYLE_RULES, PROSE_MASTERY_RULES, SOURCE_LOCK_RULES, READER_NORMALIZATION_RULES } from "@/lib/editorial-style-bible";
import { SCRIPTURE_FORMATTING_RULES } from "@/lib/scripture-formatter";

export const runtime = "nodejs";
export const maxDuration = 180;

const RequestSchema = z.object({
  mode: z.enum(["rewriteSection", "refineParagraph", "critiqueSection"]).default("rewriteSection"),
  assignment: SectionAssignmentSchema,
  currentBody: z.string().default(""),
  instruction: z.string().default(""),
  includeExcerptNumbers: z.array(z.number().int().positive()).default([]),
  paragraphIndex: z.number().int().nonnegative().optional(),
  authorConfig: z
    .object({
      instructions: z.string().default(""),
      targetAudience: z.string().default(""),
    })
    .optional(),
});

const ResponseSchema = z.object({
  paragraphs: z.array(z.string()).default([]),
  excerptUsage: z.array(z.number().int().positive()).default([]),
});

const CritiqueSchema = z.object({
  summary: z.string().default(""),
  strengths: z.array(z.string()).default([]),
  issues: z.array(z.string()).default([]),
  actions: z.array(z.string()).default([]),
});

const ParagraphRefineSchema = z.object({
  refinedParagraph: z.string().default(""),
  excerptUsage: z.array(z.number().int().positive()).default([]),
});

function splitParagraphs(body: string): string[] {
  return body
    .split(/\n\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

// Helper function removed - grounding validation is redundant with LLM fidelity rules

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as unknown;
  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }

  const { mode, assignment, currentBody, instruction, includeExcerptNumbers, paragraphIndex, authorConfig } = parsed.data;
  const includeSet = new Set(includeExcerptNumbers);
  
  // Detect additive vs full rewrite mode
  const rewriteMode = includeExcerptNumbers.length > 0 ? "additive" : "full";

  // Build excerpt block based on mode
  const excerptBlock = rewriteMode === "additive"
    ? assignment.transcriptExcerpts
        .map((excerpt, index) => {
          const number = index + 1;
          if (!includeSet.has(number)) return null;
          return `Excerpt ${number} [MUST INCLUDE]:\n${excerpt}`;
        })
        .filter(Boolean)
        .join("\n\n")
    : assignment.transcriptExcerpts
        .map((excerpt, index) => {
          const number = index + 1;
          const forced = includeSet.has(number) ? " [MUST INCLUDE]" : "";
          return `Excerpt ${number}${forced}:\n${excerpt}`;
        })
        .join("\n\n");

  // Boundary instructions for additive mode
  const boundaryInstructions = rewriteMode === "additive"
    ? `
═══ ADDITIVE REWRITE MODE ═══

You are ADDING new content to an existing section, NOT replacing it entirely.

PRESERVATION RULES:
1. KEEP all existing paragraphs that are well-grounded in transcript excerpts
2. KEEP the existing argument flow and paragraph sequence
3. KEEP existing scripture quotes and their exact formatting
4. KEEP existing stories, illustrations, and applications

ADDITION RULES:
1. Write NEW paragraphs ONLY for excerpts marked [MUST INCLUDE]
2. Insert new paragraphs at the NATURAL POSITION where these ideas appear in the transcript sequence
3. If a [MUST INCLUDE] excerpt extends or enriches an existing paragraph, MERGE it into that paragraph rather than duplicating
4. If a [MUST INCLUDE] excerpt is already substantially covered in the existing prose, DO NOT add it

OUTPUT REQUIREMENT:
Return the FULL section body with both preserved and new content in proper sequence.
`
    : `
═══ FULL SECTION REWRITE MODE ═══

You are rewriting the entire section from scratch using all provided transcript excerpts.
`;

  const rewriteSystem = `You are an elite editor rewriting one section of a teaching book.

${boundaryInstructions}
${SCRIPTURE_FORMATTING_RULES}

${SOURCE_LOCK_RULES}

${READER_NORMALIZATION_RULES}

${PROSE_MASTERY_RULES}

${PREMIUM_BOOK_STYLE_RULES}

ADDITIONAL FIDELITY RULES:
• [MUST INCLUDE] excerpts → core idea must appear clearly
• Thin material → write shorter brilliantly (never pad)
• Preserve theological sequence from transcript

Output clean prose paragraphs separated by double newlines. Do NOT wrap in JSON.`;

  // Primary translation block
  const primaryTranslationBlock = assignment.primaryTranslation
    ? `
PRIMARY BIBLE TRANSLATION: ${assignment.primaryTranslation}

When scripture in transcript has no translation specified, assume ${assignment.primaryTranslation}.
Format every scripture citation with translation in parentheses.
`
    : "";

  // Scripture positions block
  const scripturePositions = assignment.scripturePositions ?? [];
  const scripturePositionsBlock = scripturePositions.length > 0
    ? `
SCRIPTURE SEQUENCE POSITIONS — DO NOT MOVE EARLIER

Each scripture appears at a specific position in the transcript. Do NOT use a scripture before you reach the paragraph corresponding to its excerpt position:

${scripturePositions.map((p) => `• "${p.reference}" — appears in Excerpt ${p.excerptIndex + 1}. Do not use it in paragraphs anchored to earlier excerpts.`).join("\n")}
`
    : "";

  // Scripture deduplication block
  const usedScriptures = (assignment.usedQuotes ?? []).filter(q => q.reference && /\d+:\d+/.test(q.reference));
  const scriptureDeduplicationBlock = usedScriptures.length > 0
    ? `
SCRIPTURES ALREADY QUOTED IN FULL (inline reference only)

These verse texts were ALREADY REPRODUCED in an earlier section. You are FORBIDDEN from printing them again. If you reference the scripture, use ONLY its citation inline (e.g. "as John 3:16 states"). Never reprint the text:

${usedScriptures.map(q => `• ${q.reference} — DO NOT REPRODUCE TEXT`).join("\n")}
`
    : "";

  const rewritePrompt = [
    `CHAPTER ${assignment.chapterNumber}: ${assignment.chapterTitle}`,
    `SECTION ${assignment.sectionNumber}: ${assignment.heading}`,
    `TARGET WORD COUNT: ${assignment.targetWordCount}`,
    "",
    "CURRENT SECTION BODY:",
    currentBody || "(empty)",
    "",
    instruction.trim() ? `USER REWRITE INSTRUCTION:\n${instruction.trim()}\n` : "",
    authorConfig?.instructions?.trim()
      ? `AUTHOR WRITING INSTRUCTION:\n${authorConfig.instructions.trim()}\n`
      : "",
    authorConfig?.targetAudience?.trim()
      ? `TARGET AUDIENCE:\n${authorConfig.targetAudience.trim()}\n`
      : "",
    primaryTranslationBlock,
    scripturePositionsBlock,
    scriptureDeduplicationBlock,
    "TRANSCRIPT EXCERPTS:",
    excerptBlock,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    if (mode === "critiqueSection") {
      const critiquePrompt = [
        `CHAPTER ${assignment.chapterNumber}: ${assignment.chapterTitle}`,
        `SECTION ${assignment.sectionNumber}: ${assignment.heading}`,
        "",
        "SECTION BODY:",
        currentBody || "(empty)",
        "",
        "SOURCE EXCERPTS:",
        excerptBlock,
        "",
        instruction.trim() ? `USER NOTE:\n${instruction.trim()}\n` : "",
        "Return concise editorial guidance:",
        "- summary: one sentence",
        "- strengths: up to 4",
        "- issues: up to 6",
        "- actions: up to 6 concrete edits",
      ].filter(Boolean).join("\n");

      const { object } = await generateObject({
        model: deepSeekModel,
        schema: CritiqueSchema,
        mode: "json",
        temperature: 0.35,
        system: `You are a senior developmental editor critiquing one section of a published teaching book. Be precise and actionable — not generic.

Evaluate on these five dimensions:
1. SOURCE FIDELITY — Does every sentence trace to the provided transcript excerpts? Flag any sentence that appears invented, extended, or inferred beyond what the transcript says.
2. PROSE QUALITY — Are sentences the best possible expression of their idea? Flag weak verbs, vague nouns, padding, clichés, AI-signature phrases ("ultimately," "in essence," "it's important to note," "transformative"), and passive constructions.
3. ARGUMENT MOMENTUM — Does each paragraph advance the argument? Flag any paragraph that restates a previous one, treads water, or fails to move the reader forward.
4. VOICE & PERSON — Is every sentence written in first person as the author? Flag any "the speaker," "the preacher," or third-person reference to the author.
5. RHYTHM & STRUCTURE — Are sentence lengths varied? Flag runs of uniform-length sentences, back-to-back rhetorical questions, and paragraphs that close with a restatement of their opening.

For each issue identified, give a specific action: not "improve the flow" but "rewrite the third sentence of paragraph 2 — it restates paragraph 1's conclusion."
Do not invent new source facts or suggest content not in the transcript.`,
        prompt: critiquePrompt,
      });

      return NextResponse.json(object, { status: 200 });
    }

    if (mode === "refineParagraph") {
      const paragraphs = splitParagraphs(currentBody);
      if (paragraphs.length === 0) {
        return NextResponse.json({ error: "Section has no paragraphs to refine" }, { status: 422 });
      }
      if (typeof paragraphIndex !== "number" || paragraphIndex < 0 || paragraphIndex >= paragraphs.length) {
        return NextResponse.json({ error: "Invalid paragraph index for refineParagraph mode" }, { status: 400 });
      }

      const targetParagraph = paragraphs[paragraphIndex];
      const prevParagraph = paragraphIndex > 0 ? paragraphs[paragraphIndex - 1] : "";
      const nextParagraph = paragraphIndex < paragraphs.length - 1 ? paragraphs[paragraphIndex + 1] : "";

      const refinePrompt = [
        `CHAPTER ${assignment.chapterNumber}: ${assignment.chapterTitle}`,
        `SECTION ${assignment.sectionNumber}: ${assignment.heading}`,
        `PARAGRAPH INDEX TO REFINE: ${paragraphIndex + 1} of ${paragraphs.length}`,
        "",
        "PREVIOUS PARAGRAPH (context):",
        prevParagraph || "(none)",
        "",
        "TARGET PARAGRAPH (rewrite only this):",
        targetParagraph,
        "",
        "NEXT PARAGRAPH (context):",
        nextParagraph || "(none)",
        "",
        instruction.trim() ? `USER INSTRUCTION:\n${instruction.trim()}\n` : "",
        "SOURCE EXCERPTS:",
        excerptBlock,
        "",
        "Return JSON with:",
        "- refinedParagraph: rewritten paragraph only (do not include other paragraphs)",
        "- excerptUsage: excerpt numbers used",
      ].filter(Boolean).join("\n");

      const { object } = await generateObject({
        model: deepSeekModel,
        schema: ParagraphRefineSchema,
        mode: "json",
        temperature: 0.35,
        system: `You are refining exactly one paragraph of a published teaching book. Return only that one paragraph — never the surrounding context, never extra paragraphs.

THE STANDARD: The refined paragraph must be the best possible expression of the idea it carries, using only content present in the provided transcript excerpts.

ELEVATION RULES (apply before returning):
- WORD PRECISION: Replace every vague or weak word with the most exact one available. Cut adverbs — they are confessions of weak verbs. "He decided not to continue" → "He quit."
- SENTENCE RHYTHM: Vary sentence length. If the paragraph has three similarly-sized sentences, make one short and punchy. If it opens long, close short. Deliberate contrast is craft; uniformity is machine output.
- OPENING SENTENCE: Must not begin with the same word as the previous paragraph (provided for context). Must not restate the section heading. Drop the reader into the idea immediately.
- CLOSING SENTENCE: Must either land a definitive statement with force OR create forward pull via an unresolved implication. Never close by summarizing what the paragraph just said.
- FIRST PERSON: Write entirely as the author. No "the speaker," "the preacher," or any third-person reference to the author.
- NO EM DASHES: Never use — in any form. Use commas, colons, or subordinate clauses instead.
- SOURCE FIDELITY: Every sentence must trace to the transcript excerpts. Zero fabrication, zero extension.`,
        prompt: refinePrompt,
      });

      const refinedParagraph = (object.refinedParagraph ?? "").trim();
      if (!refinedParagraph) {
        return NextResponse.json({ error: "Refined paragraph was empty" }, { status: 422 });
      }

      const merged = [...paragraphs];
      merged[paragraphIndex] = refinedParagraph;
      const mergedBody = merged.join("\n\n");
      const usage = (object.excerptUsage ?? []).filter((n) => n > 0);

      return NextResponse.json({ body: mergedBody, excerptUsage: usage }, { status: 200 });
    }

    // Full section rewrite using streamText for 4x faster performance
    const stream = await streamText({
      model: deepSeekModel,
      temperature: 0.35,
      system: rewriteSystem,
      prompt: rewritePrompt,
    });

    let fullText = "";
    for await (const chunk of stream.textStream) {
      fullText += chunk;
    }

    const trimmedBody = fullText.trim();
    if (!trimmedBody) {
      return NextResponse.json({ error: "Rewrite returned empty output" }, { status: 422 });
    }

    return NextResponse.json(
      {
        body: trimmedBody,
        excerptUsage: [],
      },
      { status: 200 }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Section rewrite failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
