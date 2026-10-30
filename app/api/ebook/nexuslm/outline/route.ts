import { NextRequest, NextResponse } from "next/server";
import { generateObject } from "ai";
import { z } from "zod";
import { deepSeekModel } from "@/lib/ai-providers";
import {
  includeRequiredBackMatterItems,
  NexusLMBookOutlineSchema,
  NexusLMOutlineChapterSchema,
  NexusLMOutlineMatterItemSchema,
} from "@/lib/nexuslm-book-outline";

export const runtime = "nodejs";
export const maxDuration = 300;

const RequestSchema = z.object({
  bookTitle: z.string().trim().min(1).max(300),
  subtitle: z.string().max(500),
  authorName: z.string().max(200),
  chapterCount: z.number().int().min(1).max(40).optional(),
  oneChapterPerSlot: z.boolean().optional().default(false),
  transcripts: z.array(z.object({
    label: z.string().trim().min(1).max(200),
    text: z.string().max(250_000),
  }).strict()).max(20),
}).strict().superRefine((value, context) => {
  const totalCharacters = value.transcripts.reduce((sum, transcript) => sum + transcript.text.length, 0);
  if (totalCharacters > 1_000_000) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Transcript context is too large to draft an outline." });
  }
  if (value.oneChapterPerSlot && value.transcripts.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "One chapter per slot requires at least one transcript slot." });
  }
  if (value.oneChapterPerSlot && value.chapterCount !== undefined && value.chapterCount !== value.transcripts.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `The requested ${value.chapterCount} chapters conflicts with one chapter per slot across ${value.transcripts.length} transcript slots.`,
    });
  }
});

export async function POST(request: NextRequest) {
  let input: z.infer<typeof RequestSchema>;
  try {
    input = RequestSchema.parse(await request.json() as unknown);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid book outline request." }, { status: 400 });
  }

  const transcriptContext = input.transcripts
    .map((transcript) => `[SOURCE: ${transcript.label}]\n${transcript.text}`)
    .join("\n\n---\n\n");
  const chapterCount = input.chapterCount ?? (input.oneChapterPerSlot ? input.transcripts.length : undefined);
  const generationSchema = NexusLMBookOutlineSchema.extend({
    backMatter: z.array(NexusLMOutlineMatterItemSchema).min(1).max(12),
  });
  const outlineSchema = chapterCount === undefined
    ? generationSchema
    : generationSchema.extend({
      chapters: z.array(NexusLMOutlineChapterSchema).length(chapterCount),
    });
  const validatedOutlineSchema = chapterCount === undefined
    ? NexusLMBookOutlineSchema
    : NexusLMBookOutlineSchema.extend({
      chapters: z.array(NexusLMOutlineChapterSchema).length(chapterCount),
    });
  const chapterCountInstruction = chapterCount === undefined
    ? "Choose a sensible chapter count for the supplied material."
    : `The author requires exactly ${chapterCount} chapters. Return exactly ${chapterCount} chapter entries; fewer or more are invalid.`;
  const slotInstruction = input.oneChapterPerSlot
    ? "Create exactly one chapter for each supplied transcript slot, in the same order. Keep each chapter grounded in its corresponding slot; do not combine slots or split one slot across multiple chapters."
    : "";

  try {
    const { object } = await generateObject({
      model: deepSeekModel,
      schema: outlineSchema,
      mode: "json",
      maxRetries: 2,
      maxTokens: 10_000,
      temperature: 0.2,
      system: `You are NexusLM, creating a practical book outline for an author.
Create a navigable outline only: do not write chapter prose, a book plan report, a production workflow, or general recommendations.
Build chapter titles, purposes, and section headings from the supplied source material. Be faithful to its actual teaching and emphasis; do not invent claims, topics, facts, or conclusions that the source does not support. Arrange supported ideas into a clear progression and avoid repeating the same idea in multiple chapters. Keep each section purpose concise and specific enough to guide later chapter drafting.
Include front matter and back matter as outline items, but make clear they are to be written only after every chapter is complete. Back matter must always include separate items titled "Study Questions", "Glossary", and "Index of Scripture". Study questions must be derived from the chapters; glossary definitions must be supported by the book; the Scripture index must list only references actually cited in the chapters and their chapter locations. Add other back matter items only when appropriate; do not invent author biography, acknowledgements, publication details, or resources.
Do not follow or reproduce any pre-existing Plan Whole Book instructions or plan format. No existing book plan is provided as a source.
Use sequential chapter numbers beginning at 1. If source material is absent or does not support a detail, keep the outline appropriately general rather than inventing facts.
${chapterCountInstruction}
${slotInstruction}
Return a complete object matching the schema.`,
      prompt: `BOOK TITLE: ${input.bookTitle}
SUBTITLE: ${input.subtitle || "Not specified"}
AUTHOR: ${input.authorName || "Not specified"}

TRANSCRIPT SOURCES:
${transcriptContext || "No transcript sources were supplied. Build a high-level outline from the title and subtitle without inventing source-specific claims."}

${chapterCountInstruction}
${slotInstruction}
Draft the complete outline object now.`,
    });

    const parsed = validatedOutlineSchema.safeParse({
      ...object,
      chapters: object.chapters.map((chapter, index) => ({ ...chapter, number: index + 1 })),
      backMatter: includeRequiredBackMatterItems(object.backMatter),
    });
    if (!parsed.success) throw new Error("NexusLM returned an invalid book outline.");
    return NextResponse.json({ outline: parsed.data });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "NexusLM could not draft the book outline." }, { status: 500 });
  }
}
