import { NextRequest, NextResponse } from "next/server";
import { generateObject } from "ai";
import { z } from "zod";
import { deepSeekModel } from "@/lib/ai-providers";
import {
  formatNexusLMConversationInstructions,
  NexusLMConversationInstructionsSchema,
} from "@/lib/nexuslm-conversation";
import { includeRequiredBackMatterItems, NexusLMBookOutlineSchema } from "@/lib/nexuslm-book-outline";
import { EM_DASH_MINIMIZATION_RULES } from "@/lib/editorial-style-bible";
import { NEXUSLM_SCRIPTURE_FORMATTING_RULES } from "@/lib/scripture-formatter";
import { NexusLMResponseLengthSchema, NEXUSLM_RESPONSE_LENGTHS } from "@/lib/nexuslm-response";
import { QuoteSchema } from "@/lib/schemas/ebook";
import { buildEbookScriptureIndex } from "@/lib/ebook-scripture-index";
import {
  formatNexusLMBackMatter,
  formatNexusLMFrontMatter,
  NexusLMBackMatterFieldsSchema,
  NexusLMFrontMatterFieldsSchema,
} from "@/lib/nexuslm-matter-mapping";

export const runtime = "nodejs";
export const maxDuration = 300;

const RequestSchema = z.object({
  kind: z.enum(["frontMatter", "backMatter"]),
  bookTitle: z.string().trim().min(1).max(300),
  authorName: z.string().max(200),
  outline: NexusLMBookOutlineSchema,
  conversationInstructions: NexusLMConversationInstructionsSchema,
  chapters: z.array(z.object({
    number: z.number().int().positive().max(100),
    title: z.string().trim().min(1).max(300),
    content: z.string().max(600_000),
  }).strict()).max(100),
  allQuotes: z.array(QuoteSchema).optional().default([]),
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
    ? `Return the existing manuscript back-matter fields: a glossary with first appearances, a reading-group guide with 3–7 questions for every outlined chapter, and recommended resources only when present in the sources. The Scripture index is built from the completed chapter citations after generation.`
    : "";
  const conversationInstructions = formatNexusLMConversationInstructions(input.conversationInstructions);

  try {
    const system = `ALL SCRIPTURE MUST BE IN BLOCK QUOTES.
You are NexusLM, writing the ${matterLabel} for a completed book.
Write only the requested matter. This material is written after all chapters; do not draft or revise chapters.
Apply relevant requirements and corrections from the user's chat instructions. Newer applicable user instructions override older conflicting preferences.
Treat the completed manuscript and supplied transcripts as the only authority for factual claims. Be faithful to their meaning and emphasis. Do not invent, infer, embellish, or add facts, examples, quotations, doctrine, biography, acknowledgements, publication details, resources, or scripture not explicitly supported by the sources. If a requested field requires unavailable information, leave it empty rather than filling the gap.
${backMatterInstruction}
${EM_DASH_MINIMIZATION_RULES}
${NEXUSLM_SCRIPTURE_FORMATTING_RULES}
${responseLength.instruction}`;
    const prompt = `BOOK: ${input.bookTitle}
AUTHOR: ${input.authorName || "Not specified"}

${matterLabel.toUpperCase()} FIELDS:
${matterItems.map((item, index) => `${index + 1}. ${item.title}\nPurpose: ${item.purpose}`).join("\n\n")}

${conversationInstructions}

COMPLETED CHAPTERS:
${chapterContext}

TRANSCRIPT SOURCES:
${transcriptContext || "No transcript sources supplied."}

Write complete, polished reader-facing content for these fields, grounded in the completed book.`;
    if (input.kind === "frontMatter") {
      const { object } = await generateObject({
        model: deepSeekModel,
        schema: NexusLMFrontMatterFieldsSchema,
        mode: "json",
        maxRetries: 2,
        maxTokens: responseLength.draftTokens,
        system,
        prompt,
      });
      const fields = NexusLMFrontMatterFieldsSchema.parse(object);
      return NextResponse.json({
        content: formatNexusLMFrontMatter(fields),
        matter: { kind: "frontMatter", fields },
      });
    }

    const { object } = await generateObject({
      model: deepSeekModel,
      schema: NexusLMBackMatterFieldsSchema.omit({ scriptureIndex: true }),
      mode: "json",
      maxRetries: 2,
      maxTokens: responseLength.draftTokens,
      system,
      prompt,
    });
    const fields = NexusLMBackMatterFieldsSchema.parse({
      ...object,
      scriptureIndex: buildEbookScriptureIndex(
        input.chapters.map(({ number, content }) => ({ number, content })),
        input.allQuotes,
      ),
    });
    return NextResponse.json({
      content: formatNexusLMBackMatter(fields),
      matter: { kind: "backMatter", fields },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : `NexusLM could not draft the ${matterLabel}.` }, { status: 500 });
  }
}
