import { NextRequest, NextResponse } from "next/server";
import { generateObject } from "ai";
import { z } from "zod";
import { deepSeekModel } from "@/lib/ai-providers";
import { NexusLMBookOutlineSchema } from "@/lib/nexuslm-book-outline";

export const runtime = "nodejs";
export const maxDuration = 300;

const RequestSchema = z.object({
  bookTitle: z.string().trim().min(1).max(300),
  subtitle: z.string().max(500),
  authorName: z.string().max(200),
  transcripts: z.array(z.object({
    label: z.string().trim().min(1).max(200),
    text: z.string().max(250_000),
  }).strict()).max(20),
}).strict().superRefine((value, context) => {
  const totalCharacters = value.transcripts.reduce((sum, transcript) => sum + transcript.text.length, 0);
  if (totalCharacters > 1_000_000) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Transcript context is too large to draft an outline." });
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

  try {
    const { object } = await generateObject({
      model: deepSeekModel,
      schema: NexusLMBookOutlineSchema,
      mode: "json",
      maxRetries: 2,
      maxTokens: 10_000,
      temperature: 0.2,
      system: `You are NexusLM, creating a practical book outline for an author.
Create a navigable outline only: do not write chapter prose, a book plan report, a production workflow, or general recommendations.
Build chapter titles, purposes, and section headings from the supplied source material. Arrange ideas into a clear progression and avoid repeating the same idea in multiple chapters. Keep each section purpose concise and specific enough to guide later chapter drafting.
Include front matter and back matter as outline items, but make clear they are to be written only after every chapter is complete. Choose only items appropriate to this book; do not invent author biography, acknowledgements, publication details, or resources.
Do not follow or reproduce any pre-existing Plan Whole Book instructions or plan format. No existing book plan is provided as a source.
Use sequential chapter numbers beginning at 1. If source material is absent or does not support a detail, keep the outline appropriately general rather than inventing facts.
Return a complete object matching the schema.`,
      prompt: `BOOK TITLE: ${input.bookTitle}
SUBTITLE: ${input.subtitle || "Not specified"}
AUTHOR: ${input.authorName || "Not specified"}

TRANSCRIPT SOURCES:
${transcriptContext || "No transcript sources were supplied. Build a high-level outline from the title and subtitle without inventing source-specific claims."}

Draft the complete outline object now.`,
    });

    const parsed = NexusLMBookOutlineSchema.safeParse({
      ...object,
      chapters: object.chapters.map((chapter, index) => ({ ...chapter, number: index + 1 })),
    });
    if (!parsed.success) throw new Error("NexusLM returned an invalid book outline.");
    return NextResponse.json({ outline: parsed.data });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "NexusLM could not draft the book outline." }, { status: 500 });
  }
}
