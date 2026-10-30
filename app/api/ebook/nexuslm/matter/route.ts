import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { z } from "zod";
import { deepSeekModel } from "@/lib/ai-providers";
import { includeRequiredBackMatterItems, NexusLMBookOutlineSchema } from "@/lib/nexuslm-book-outline";
import { EM_DASH_MINIMIZATION_RULES } from "@/lib/editorial-style-bible";
import { normalizeScriptureBlockquotes, NEXUSLM_SCRIPTURE_FORMATTING_RULES } from "@/lib/scripture-formatter";
import { NexusLMResponseLengthSchema, NEXUSLM_RESPONSE_LENGTHS, sanitizeNexusLMText } from "@/lib/nexuslm-response";

export const runtime = "nodejs";
export const maxDuration = 300;

const RequestSchema = z.object({
  kind: z.enum(["frontMatter", "backMatter"]),
  bookTitle: z.string().trim().min(1).max(300),
  authorName: z.string().max(200),
  outline: NexusLMBookOutlineSchema,
  chapters: z.array(z.object({
    number: z.number().int().positive().max(100),
    title: z.string().trim().min(1).max(300),
    content: z.string().max(600_000),
  }).strict()).max(100),
  transcripts: z.array(z.object({
    label: z.string().trim().min(1).max(200),
    text: z.string().max(250_000),
  }).strict()).max(20),
  responseLength: NexusLMResponseLengthSchema.default("default"),
}).strict().superRefine((value, context) => {
  const totalCharacters = value.transcripts.reduce((sum, transcript) => sum + transcript.text.length, 0)
    + value.chapters.reduce((sum, chapter) => sum + chapter.content.length, 0);
  if (totalCharacters > 1_500_000) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Book context is too large to draft the matter section." });
  }
  const missingChapters = value.outline.chapters.filter((chapter) => !value.chapters.some((written) => written.number === chapter.number));
  if (missingChapters.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Finish every outlined chapter before drafting matter. Missing: ${missingChapters.map((chapter) => chapter.number).join(", ")}.`,
    });
  }
});

export async function POST(request: NextRequest) {
  let input: z.infer<typeof RequestSchema>;
  try {
    input = RequestSchema.parse(await request.json() as unknown);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid book matter request." }, { status: 400 });
  }

  const matterItems = input.kind === "frontMatter"
    ? input.outline.frontMatter
    : includeRequiredBackMatterItems(input.outline.backMatter);
  const matterLabel = input.kind === "frontMatter" ? "front matter" : "back matter";
  const chapterContext = input.chapters.map((chapter) => {
    const content = chapter.content.trim();
    const excerpt = content.length > 8_000
      ? `${content.slice(0, 6_000)}\n\n[Chapter middle omitted]\n\n${content.slice(-1_800)}`
      : content;
    return `CHAPTER ${chapter.number}: ${chapter.title}\n${excerpt}`;
  }).join("\n\n==========\n\n");
  const transcriptContext = input.transcripts
    .map((transcript) => `[SOURCE: ${transcript.label}]\n${transcript.text}`)
    .join("\n\n---\n\n");
  const responseLength = NEXUSLM_RESPONSE_LENGTHS[input.responseLength];
  const backMatterInstruction = input.kind === "backMatter"
    ? `For Study Questions, provide chapter-grouped questions drawn only from the completed chapters. For the Glossary, define only terms whose meaning is supported by the completed chapters. For the Index of Scripture, list only references actually cited in those chapters and identify the chapter number(s) where each appears; do not add verse wording or uncited references.`
    : "";

  try {
    const { text } = await generateText({
      model: deepSeekModel,
      maxRetries: 2,
      maxTokens: responseLength.draftTokens,
      system: `You are NexusLM, writing the ${matterLabel} for a completed book.
Write only the requested matter items, in the exact outline order, using each item title as a heading. This material is written after all chapters; do not draft or revise chapters.
Treat the completed manuscript and supplied transcripts as the only authority for factual claims. Be faithful to their meaning and emphasis. Do not invent, infer, embellish, or add facts, examples, quotations, doctrine, biography, acknowledgements, publication details, resources, or scripture not explicitly supported by the sources. If an outline item requires unavailable information, use a brief clearly marked [Author input needed] placeholder rather than filling the gap.
${backMatterInstruction}
${EM_DASH_MINIMIZATION_RULES}
${NEXUSLM_SCRIPTURE_FORMATTING_RULES}
Every quoted Scripture passage, even one verse or a short phrase, MUST be a standalone Markdown blockquote with its reference on a separate blockquote line; never put Scripture in inline prose. Quote only wording present in the supplied source. If the source provides only a reference, do not invent verse wording.
${responseLength.instruction}`,
      prompt: `BOOK: ${input.bookTitle}
AUTHOR: ${input.authorName || "Not specified"}

${matterLabel.toUpperCase()} OUTLINE:
${matterItems.map((item, index) => `${index + 1}. ${item.title}\nPurpose: ${item.purpose}`).join("\n\n")}

COMPLETED CHAPTERS:
${chapterContext}

TRANSCRIPT SOURCES:
${transcriptContext || "No transcript sources supplied."}

Write the complete ${matterLabel} now. Return reader-facing content only.`,
    });
    const content = normalizeScriptureBlockquotes(sanitizeNexusLMText(text.trim()));
    if (!content) throw new Error(`NexusLM returned empty ${matterLabel}.`);
    return NextResponse.json({ content });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : `NexusLM could not draft the ${matterLabel}.` }, { status: 500 });
  }
}
