import { NextRequest, NextResponse } from "next/server";
import { generateObject, generateText } from "ai";
import { z } from "zod";
import { deepSeekModel, deepSeekReasonerModel } from "@/lib/ai-providers";
import { ChapterDraftSchema } from "@/lib/schemas/ebook";
import { DIRECT_CHAPTER_WRITING_RULES, SOURCE_LOCK_RULES, PROSE_MASTERY_RULES, READER_NORMALIZATION_RULES, PREMIUM_BOOK_STYLE_RULES } from "@/lib/editorial-style-bible";
import { SCRIPTURE_FORMATTING_RULES } from "@/lib/scripture-formatter";
import { NexusLMWritingStyleSchema, NEXUSLM_WRITING_STYLES } from "@/lib/nexuslm-writing-styles";
import { NexusLMAgentSchema } from "@/lib/nexuslm-agents";
import { NexusLMResponseLengthSchema, NEXUSLM_RESPONSE_LENGTHS, sanitizeNexusLMText } from "@/lib/nexuslm-response";

export const runtime = "nodejs";
export const maxDuration = 300;

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
  agent: NexusLMAgentSchema.default("nexusR1"),
  writingStyle: NexusLMWritingStyleSchema.default("book-prose"),
  responseLength: NexusLMResponseLengthSchema.default("default"),
  vettingGuidance: z.string().max(20000).optional(),
}).superRefine((value, context) => {
  const totalCharacters = value.transcripts.reduce((sum, transcript) => sum + transcript.text.length, 0);
  if (totalCharacters > 1000000) context.addIssue({ code: z.ZodIssueCode.custom, message: "Transcript context is too large." });
});

type DraftInput = z.infer<typeof RequestSchema>;
type DraftObject = z.infer<typeof ChapterDraftSchema>;

function parseDraftText(text: string): DraftObject | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = ChapterDraftSchema.safeParse(JSON.parse(text.slice(start, end + 1)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function fallbackDraft(input: DraftInput): DraftObject {
  const existing = input.book.manuscriptChapter;
  if (existing && existing.sections.some((section) => section.body.trim())) {
    return {
      ...existing,
      number: input.chapterNumber,
      sections: existing.sections.map((section) => ({ ...section, status: "complete" as const })),
      status: "complete",
    };
  }

  const body = input.transcripts.map((transcript) => transcript.text.trim()).filter(Boolean).join("\n\n");
  return {
    number: input.chapterNumber,
    title: `Chapter ${input.chapterNumber}`,
    intro: "",
    epigraph: "",
    sections: [{ chapterNumber: input.chapterNumber, sectionNumber: 1, heading: "Source material", body, wordCount: body.split(/\s+/).filter(Boolean).length, status: "complete" }],
    forwardQuestion: "",
    keyTakeaways: [],
    reflectionQuestions: [],
    totalWordCount: body.split(/\s+/).filter(Boolean).length,
    status: "complete",
  };
}

export async function POST(request: NextRequest) {
  let input: z.infer<typeof RequestSchema>;
  try {
    input = RequestSchema.parse(await request.json() as unknown);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid chapter draft request." }, { status: 400 });
  }

  const chapterTitles = input.book.chapters.map((chapter) => `${chapter.number}. ${chapter.title}`).join("\n");
  const manuscriptChapter = input.book.manuscriptChapter
    ? JSON.stringify(input.book.manuscriptChapter)
    : "No existing chapter text is available.";
  const transcriptContext = input.transcripts
    .map((transcript) => `[SOURCE: ${transcript.label}]\n${transcript.text}`)
    .join("\n\n---\n\n");
  const writingStyle = NEXUSLM_WRITING_STYLES[input.writingStyle];
  const responseLength = NEXUSLM_RESPONSE_LENGTHS[input.responseLength];

  try {
    const system = `Return only one valid JSON object matching the ChapterDraft schema. Do not wrap it in markdown fences and do not include reasoning outside the JSON object.
You are NexusLM, a professional book ghostwriter. Selected agent: ${input.agent}. Persona: ${input.persona}.
Presentation form: ${writingStyle.label}. ${writingStyle.instruction}
Write only from the supplied manuscript context and transcript sources. Do not invent teachings, stories, quotations, facts, or theological claims. Preserve the author's voice and remove live-audience language.
${DIRECT_CHAPTER_WRITING_RULES}
${SOURCE_LOCK_RULES}
${READER_NORMALIZATION_RULES}
${PROSE_MASTERY_RULES}
${PREMIUM_BOOK_STYLE_RULES}
${SCRIPTURE_FORMATTING_RULES}
Return a complete ChapterDraft object. The sections must contain readable prose in the body field, not planning notes. ${responseLength.instruction}
Do not expose source IDs, slot labels, retrieval markers, or internal routing labels in any field. Use standalone blockquotes for Scripture exactly as required above.`;
    const prompt = `RESPONSE LENGTH: ${responseLength.label}. ${responseLength.instruction}

BOOK: ${input.book.title}
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

Return JSON only.`;

    let object: DraftObject;
    try {
      ({ object } = await generateObject({
        model: input.agent === "nexusR1" ? deepSeekReasonerModel : deepSeekModel,
        schema: ChapterDraftSchema,
        mode: "json",
        maxRetries: 2,
        maxTokens: responseLength.draftTokens,
        system,
        prompt,
      }));
    } catch (primaryError) {
      console.error("[nexuslm/draft] structured generation failed:", primaryError);
      try {
        const textResult = await generateText({
          model: input.agent === "nexusR1" ? deepSeekReasonerModel : deepSeekModel,
          maxRetries: 2,
          maxTokens: responseLength.draftTokens,
          system: `${system}\nIf structured output is unavailable, return the JSON object as plain text with no commentary.`,
          prompt,
        });
        const parsedText = parseDraftText(textResult.text);
        if (!parsedText) throw new Error("The model returned no parseable ChapterDraft JSON.");
        object = parsedText;
      } catch (textError) {
        console.error("[nexuslm/draft] text recovery failed:", textError);
        if (input.agent === "nexusR1") {
          try {
            ({ object } = await generateObject({
              model: deepSeekModel,
              schema: ChapterDraftSchema,
              mode: "json",
              maxRetries: 2,
              maxTokens: responseLength.draftTokens,
              system,
              prompt,
            }));
          } catch (fallbackError) {
            console.error("[nexuslm/draft] NexusChat fallback failed:", fallbackError);
            object = fallbackDraft(input);
          }
        } else {
          object = fallbackDraft(input);
        }
      }
    }
    let sections = object.sections.map((section, index) => {
      const body = sanitizeNexusLMText(section.body.trim());
      return {
        chapterNumber: input.chapterNumber,
        sectionNumber: section.sectionNumber || index + 1,
        heading: sanitizeNexusLMText(section.heading.trim()) || `Section ${index + 1}`,
        body,
        wordCount: section.wordCount > 0 ? section.wordCount : body.split(/\s+/).filter(Boolean).length,
        status: "complete" as const,
      };
    });
    if (sections.length === 0 || sections.every((section) => !section.body.trim())) {
      const fallbackSections = fallbackDraft(input).sections.map((section, index) => ({
        chapterNumber: input.chapterNumber,
        sectionNumber: section.sectionNumber || index + 1,
        heading: sanitizeNexusLMText(section.heading.trim()) || `Section ${index + 1}`,
        body: sanitizeNexusLMText(section.body.trim()),
        wordCount: section.body.split(/\s+/).filter(Boolean).length,
        status: "complete" as const,
      }));
      if (fallbackSections.every((section) => !section.body.trim())) {
        throw new Error("No source-backed chapter content was available.");
      }
      sections = fallbackSections;
    }
    const normalizedCandidate = {
      ...object,
      number: input.chapterNumber,
      title: sanitizeNexusLMText(object.title.trim()) || `Chapter ${input.chapterNumber}`,
      intro: sanitizeNexusLMText(object.intro.trim()),
      epigraph: sanitizeNexusLMText(object.epigraph.trim()),
      sections,
      forwardQuestion: sanitizeNexusLMText(object.forwardQuestion.trim()),
      keyTakeaways: object.keyTakeaways.map((value) => sanitizeNexusLMText(String(value))),
      reflectionQuestions: object.reflectionQuestions.map((value) => sanitizeNexusLMText(String(value))),
      totalWordCount: sections.reduce((sum, section) => sum + section.wordCount, 0),
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
