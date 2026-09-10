import { NextRequest, NextResponse } from "next/server";
import { generateObject } from "ai";
import { z } from "zod";
import { deepSeekReasonerModel } from "@/lib/ai-providers";
import { SOURCE_LOCK_RULES } from "@/lib/editorial-style-bible";

export const runtime = "nodejs";
export const maxDuration = 300;

const RequestSchema = z.object({
  rawTranscript: z.string().min(500).max(500000),
  targetAudience: z.string().max(500).optional().default(""),
  coreThesis: z.string().max(2000).optional().default(""),
  voiceTone: z.string().max(500).optional().default(""),
  authorInstructions: z.string().max(4000).optional().default(""),
  desiredChapters: z.number().int().min(3).max(12).optional().default(6),
});

const SectionSchema = z.object({
  sectionNumber: z.number().int().positive(),
  heading: z.string().default(""),
  body: z.string().default(""),
  keyClaims: z.array(z.string()).default([]),
});

const ChapterSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().default(""),
  premise: z.string().default(""),
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

  const maxTokens = Math.min(24000, Math.max(8000, Math.floor(input.rawTranscript.length / 4)));

  const system = `You are Nexus Book Architect+Writer in single-pass mode.

You must produce a clean, publication-ready book draft from sermon transcript material using one deterministic philosophy:
- Simple and direct structure like Sermon Assistant
- Strong chapter titles and section headings
- Zero concept duplication across sections and chapters
- Strict transcript grounding

NON-NEGOTIABLE RULES:
1) Every chapter gets exactly 5 sections when source depth allows. If not possible, use 4 sections.
2) Chapter titles must be 4-7 words, punchy, complete phrases.
3) Section headings must be 4-8 words, complete phrases, never dangling.
4) Subtitle must be useful and reader-facing, never empty.
5) No duplication: once a concept is fully developed in one section, do not repeat it in later sections.
6) Keep chronological integrity unless a minimal reorder is required for clarity.
7) Every section body must be transcript-grounded and specific.
8) Avoid generic headings like Introduction, Overview, Summary, Conclusion.
9) Output valid JSON only.

${SOURCE_LOCK_RULES}`;

  const prompt = `Create a simple, sermon-assistant-style book in one pass.

DESIRED CHAPTER COUNT: ${input.desiredChapters}
TARGET AUDIENCE: ${input.targetAudience || "(not provided)"}
CORE THESIS: ${input.coreThesis || "(not provided)"}
VOICE TONE: ${input.voiceTone || "(not provided)"}
AUTHOR INSTRUCTIONS: ${input.authorInstructions || "(not provided)"}

RAW TRANSCRIPT:
${input.rawTranscript}`;

  try {
    const { object } = await generateObject({
      model: deepSeekReasonerModel,
      schema: SimpleBookSchema,
      mode: "json",
      temperature: 0.35,
      maxTokens,
      system,
      prompt,
    });

    const normalized = {
      ...object,
      subtitle: (object.subtitle || "").trim() || nonEmptySubtitle(input.targetAudience, input.coreThesis),
      strategy: "single-pass-sermon-style",
      chapters: (object.chapters ?? [])
        .map((chapter, chapterIndex) => ({
          ...chapter,
          number: chapterIndex + 1,
          sections: (chapter.sections ?? [])
            .filter((section) => (section.body || "").trim().length > 0)
            .map((section, sectionIndex) => ({
              ...section,
              sectionNumber: sectionIndex + 1,
            })),
        }))
        .filter((chapter) => chapter.sections.length > 0),
    };

    return NextResponse.json(normalized);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Simple book generation failed" },
      { status: 500 }
    );
  }
}
