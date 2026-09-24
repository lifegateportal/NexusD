import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { z } from "zod";
import { deepSeekReasonerModel } from "@/lib/ai-providers";
import { ChapterDraftSchema } from "@/lib/schemas/ebook";
import { SOURCE_LOCK_RULES, PROSE_MASTERY_RULES, READER_NORMALIZATION_RULES, PREMIUM_BOOK_STYLE_RULES } from "@/lib/editorial-style-bible";
import { SCRIPTURE_FORMATTING_RULES } from "@/lib/scripture-formatter";

export const runtime = "nodejs";
export const maxDuration = 180;

const RequestSchema = z.object({
  instruction: z.string().min(1).max(4000),
  chapterNumber: z.number().int().positive(),
  book: z.object({
    title: z.string().max(2000),
    chapters: z.array(z.object({ number: z.number().int().positive(), title: z.string().max(300) })).max(100),
    manuscriptChapter: ChapterDraftSchema.nullable(),
  }),
  transcripts: z.array(z.object({ label: z.string().min(1).max(200), text: z.string().max(250000) })).max(20),
  persona: z.string().min(1).max(80),
  vettingGuidance: z.string().max(20000).optional(),
}).superRefine((value, context) => {
  const totalCharacters = value.transcripts.reduce((sum, transcript) => sum + transcript.text.length, 0);
  if (totalCharacters > 1000000) context.addIssue({ code: z.ZodIssueCode.custom, message: "Transcript context is too large." });
});

export async function POST(request: NextRequest) {
  let input: z.infer<typeof RequestSchema>;
  try {
    input = RequestSchema.parse(await request.json() as unknown);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid chapter draft request." }, { status: 400 });
  }

  const chapterTitles = input.book.chapters.map((chapter) => `${chapter.number}. ${chapter.title}`).join("\n");
  const manuscriptChapter = input.book.manuscriptChapter
    ? JSON.stringify(input.book.manuscriptChapter).slice(0, 120000)
    : "No existing chapter text is available.";
  const transcriptContext = input.transcripts
    .map((transcript) => `[SOURCE: ${transcript.label}]\n${transcript.text.slice(0, 50000)}`)
    .join("\n\n---\n\n");

  try {
    const { text } = await generateText({
      model: deepSeekReasonerModel,
      maxTokens: 24000,
      system: `Return only one valid JSON object matching the ChapterDraft schema. Do not wrap it in markdown fences and do not include reasoning outside the JSON object.
You are NexusLM, a professional book ghostwriter. Persona: ${input.persona}.
Write only from the supplied manuscript context and transcript sources. Do not invent teachings, stories, quotations, facts, or theological claims. Preserve the author's voice and remove live-audience language.
${SOURCE_LOCK_RULES}
${READER_NORMALIZATION_RULES}
${PROSE_MASTERY_RULES}
${PREMIUM_BOOK_STYLE_RULES}
${SCRIPTURE_FORMATTING_RULES}
Return a complete ChapterDraft object. The sections must contain readable prose in the body field, not planning notes.`,
      prompt: `BOOK: ${input.book.title}
EXISTING CHAPTER OUTLINE:
${chapterTitles || "No outline available."}

REQUEST:
Write Chapter ${input.chapterNumber} based on this request: ${input.instruction}

CURRENT MANUSCRIPT CHAPTER:
${manuscriptChapter}

TRANSCRIPT SOURCES:
${transcriptContext || "No transcript sources were uploaded. State that source material is insufficient in the chapter draft."}

VETTING GUIDANCE TO IMPLEMENT:
${input.vettingGuidance || "No prior vetting guidance was provided."}

Return JSON only.`,
    });
    const jsonStart = text.indexOf("{");
    const jsonEnd = text.lastIndexOf("}");
    if (jsonStart < 0 || jsonEnd <= jsonStart) {
      throw new Error("The reasoner returned no JSON chapter draft.");
    }
    const raw = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as Record<string, unknown>;
    const candidate = (raw.chapter ?? raw.draft ?? raw) as Record<string, unknown>;
    const rawSections = Array.isArray(candidate.sections) ? candidate.sections : [];
    const sections = rawSections.map((section, index) => {
      const item = (section ?? {}) as Record<string, unknown>;
      return {
        chapterNumber: input.chapterNumber,
        sectionNumber: typeof item.sectionNumber === "number" ? item.sectionNumber : index + 1,
        heading: String(item.heading ?? item.title ?? `Section ${index + 1}`),
        body: String(item.body ?? item.content ?? item.text ?? ""),
        wordCount: typeof item.wordCount === "number" ? item.wordCount : String(item.body ?? item.content ?? item.text ?? "").trim().split(/\s+/).filter(Boolean).length,
        status: "complete" as const,
      };
    });
    if (sections.length === 0 || sections.every((section) => !section.body.trim())) {
      throw new Error("The reasoner returned no usable chapter sections. Please try again.");
    }
    const normalizedCandidate = {
      ...candidate,
      number: input.chapterNumber,
      title: String(candidate.title ?? candidate.chapterTitle ?? `Chapter ${input.chapterNumber}`),
      intro: String(candidate.intro ?? candidate.introduction ?? ""),
      epigraph: String(candidate.epigraph ?? ""),
      sections,
      forwardQuestion: String(candidate.forwardQuestion ?? ""),
      keyTakeaways: Array.isArray(candidate.keyTakeaways) ? candidate.keyTakeaways.map(String) : [],
      reflectionQuestions: Array.isArray(candidate.reflectionQuestions) ? candidate.reflectionQuestions.map(String) : [],
      totalWordCount: typeof candidate.totalWordCount === "number"
        ? candidate.totalWordCount
        : sections.reduce((sum, section) => sum + section.wordCount, 0),
      status: "complete" as const,
    };
    const parsed = ChapterDraftSchema.safeParse(normalizedCandidate);
    if (!parsed.success) {
      throw new Error("The reasoner returned a chapter that did not match the manuscript schema.");
    }
    return NextResponse.json({ chapter: { ...parsed.data, number: input.chapterNumber, status: "complete" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "NexusLM could not draft the chapter." }, { status: 500 });
  }
}
