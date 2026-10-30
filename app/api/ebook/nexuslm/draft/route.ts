import { NextRequest, NextResponse } from "next/server";
import { generateObject } from "ai";
import { z } from "zod";
import { deepSeekModel, deepSeekReasonerModel } from "@/lib/ai-providers";
import {
  formatNexusLMConversationInstructions,
  NexusLMConversationInstructionsSchema,
} from "@/lib/nexuslm-conversation";
import { EM_DASH_MINIMIZATION_RULES } from "@/lib/editorial-style-bible";
import { ChapterDraftSchema } from "@/lib/schemas/ebook";
import { NEXUSLM_SCRIPTURE_FORMATTING_RULES } from "@/lib/scripture-formatter";
import { NexusLMWritingStyleSchema, NEXUSLM_WRITING_STYLES } from "@/lib/nexuslm-writing-styles";
import { NexusLMAgentSchema } from "@/lib/nexuslm-agents";
import { NexusLMResponseLengthSchema, NEXUSLM_RESPONSE_LENGTHS, sanitizeNexusLMText } from "@/lib/nexuslm-response";
import { NexusLMBookOutlineSchema } from "@/lib/nexuslm-book-outline";

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
  outline: NexusLMBookOutlineSchema.nullable().optional(),
  conversationInstructions: NexusLMConversationInstructionsSchema,
  transcripts: z.array(z.object({ label: z.string().min(1).max(200), text: z.string().max(250000) })).max(20),
  persona: z.string().min(1).max(80),
  agent: NexusLMAgentSchema.default("nexusR1"),
  writingStyle: NexusLMWritingStyleSchema.default("book-prose"),
  responseLength: NexusLMResponseLengthSchema.default("default"),
  llmTemperature: z.number().min(0).max(1).optional(),
  transcriptScope: z.enum(["all", "selected"]).default("all"),
  selectedTranscriptLabel: z.string().trim().min(1).max(200).nullable().optional(),
}).superRefine((value, context) => {
  const totalCharacters = value.transcripts.reduce((sum, transcript) => sum + transcript.text.length, 0);
  if (totalCharacters > 1000000) context.addIssue({ code: z.ZodIssueCode.custom, message: "Transcript context is too large." });
  if (value.transcriptScope === "selected" && (
    !value.selectedTranscriptLabel ||
    value.transcripts.length !== 1 ||
    value.transcripts[0]?.label !== value.selectedTranscriptLabel
  )) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "The selected transcript slot was not supplied exactly." });
  }
  if (value.outline && !value.outline.chapters.some((chapter) => chapter.number === value.chapterNumber)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `Chapter ${value.chapterNumber} is not in the saved book outline.` });
  }
});

type DraftObject = z.infer<typeof ChapterDraftSchema>;

export async function POST(request: NextRequest) {
  let input: z.infer<typeof RequestSchema>;
  try {
    input = RequestSchema.parse(await request.json() as unknown);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid chapter draft request." }, { status: 400 });
  }

  const chapterTitles = input.book.chapters.map((chapter) => `${chapter.number}. ${chapter.title}`).join("\n");
  const outlineChapter = input.outline?.chapters.find((chapter) => chapter.number === input.chapterNumber);
  const outlineInstruction = outlineChapter
    ? `Follow the saved book outline for this chapter. Preserve its title, purpose, and section sequence. Use every listed section heading, develop each section according to its purpose, and do not add, remove, reorder, or rename outlined sections.
OUTLINED CHAPTER ${outlineChapter.number}: ${outlineChapter.title}
PURPOSE: ${outlineChapter.purpose}
SECTIONS:
${outlineChapter.sections.map((section, index) => `${index + 1}. ${section.heading}\nPurpose: ${section.purpose}`).join("\n\n")}`
    : "No saved book outline was supplied. Choose a coherent chapter structure freely.";
  const manuscriptChapter = input.book.manuscriptChapter
    ? JSON.stringify(input.book.manuscriptChapter)
    : "No existing chapter text is available.";
  const transcriptContext = input.transcripts
    .map((transcript) => `[SOURCE: ${transcript.label}]\n${transcript.text}`)
    .join("\n\n---\n\n");
  const writingStyle = NEXUSLM_WRITING_STYLES[input.writingStyle];
  const responseLength = NEXUSLM_RESPONSE_LENGTHS[input.responseLength];
  const transcriptScopeInstruction = input.transcriptScope === "selected"
    ? `Use only the selected transcript slot "${input.selectedTranscriptLabel}" supplied below as source material for this chapter.`
    : "Use all transcript slots supplied below as source material, choosing the strongest material for this chapter.";
  const conversationInstructions = formatNexusLMConversationInstructions(input.conversationInstructions);

  try {
    const system = `ALL SCRIPTURE MUST BE IN BLOCK QUOTES.
Return only one valid JSON object matching the ChapterDraft schema. Do not wrap it in markdown fences and do not include reasoning outside the JSON object.
You are NexusLM, a professional book ghostwriter. Selected agent: ${input.agent}. Persona: ${input.persona}.
Presentation form: ${writingStyle.label}. ${writingStyle.instruction}
${transcriptScopeInstruction} Treat the supplied transcript as the authority for factual, theological, biographical, and scriptural claims. Be faithful to its meaning and emphasis. Do not invent, infer, embellish, or add facts, examples, testimonies, quotations, doctrine, claims, or scripture not explicitly supported by the supplied source. If material is missing, omit it or mark the gap for author input; never fill it in.
${outlineChapter ? "The saved book outline is the required structure for this chapter; follow its title, purpose, headings, and order exactly while writing polished prose." : "Choose a coherent chapter structure from the supported source material. Do not treat an existing manuscript chapter, chapter premise, key point, or prior wording as mandatory."}
Apply relevant requirements and corrections from the user's chat instructions. Follow the latest applicable user instruction when it conflicts with a general formatting preference.
Use only connective wording and transitions as original composition; they must not introduce new information or change the source's meaning. Preserve significant points without exaggeration, omission, or unsupported expansion. Remove live-audience language without changing the teaching.
  CHAPTER OPENING PLACEMENT: Leave the ChapterDraft intro field empty. Do not write a separate premise, overview, thesis summary, or chapter-preview block before the body. The actual chapter introduction belongs in the opening paragraphs of Section 1, written as finished reader-facing prose that enters the chapter's material directly. Section 1 must begin with the chapter body, not planning language or a summary of what the chapter will discuss.
  SERIES-SERMON TO BOOK TRANSFORMATION: Sermon transcripts may recap earlier messages. Treat that recap as source context, not as mandatory chapter-opening material. Do not open with "last week," "as we saw," "continuing this series," or a replay of an earlier chapter. If the recap helps orient the reader, compress it into the shortest useful bridge and pivot quickly to this chapter's new movement. Write for a reader who may not have attended the sermon, and do not make the book repeat live-series catch-up.
  ${EM_DASH_MINIMIZATION_RULES}
  ${NEXUSLM_SCRIPTURE_FORMATTING_RULES}
  Return a complete ChapterDraft object. The sections must contain readable prose in the body field, not planning notes. ${responseLength.instruction}
  Do not expose source IDs, slot labels, retrieval markers, or internal routing labels in any field.`;
    const prompt = `RESPONSE LENGTH: ${responseLength.label}. ${responseLength.instruction}

BOOK: ${input.book.title}
EXISTING CHAPTER OUTLINE:
${chapterTitles || "No outline available."}

${outlineInstruction}

${conversationInstructions}

REQUEST:
Write Chapter ${input.chapterNumber} based on this request: ${input.instruction}

CURRENT MANUSCRIPT CHAPTER:
${manuscriptChapter}
Treat this as optional background only. You may substantially reshape or replace its introduction, section bodies, and organization.

TRANSCRIPT SOURCES:
${transcriptContext || "No transcript sources were uploaded. State that source material is insufficient in the chapter draft."}

Return JSON only.`;

    const { object } = await generateObject({
      model: input.agent === "nexusR1" ? deepSeekReasonerModel : deepSeekModel,
      schema: ChapterDraftSchema,
      mode: "json",
      maxRetries: 2,
      maxTokens: responseLength.draftTokens,
      ...(input.llmTemperature === undefined ? {} : { temperature: input.llmTemperature }),
      system,
      prompt,
    });
    let sections = await Promise.all(object.sections.map(async (section, index) => {
      const body = sanitizeNexusLMText(section.body.trim());
      return {
        chapterNumber: input.chapterNumber,
        sectionNumber: section.sectionNumber || index + 1,
        heading: sanitizeNexusLMText(section.heading.trim()) || `Section ${index + 1}`,
        body,
        wordCount: section.wordCount > 0 ? section.wordCount : body.split(/\s+/).filter(Boolean).length,
        status: "complete" as const,
      };
    }));
    if (sections.length === 0 || sections.every((section) => !section.body.trim())) {
      throw new Error("The selected model returned no usable chapter sections.");
    }
    const normalizeText = (value: string) => sanitizeNexusLMText(value);
    const normalizedCandidate = {
      ...object,
      number: input.chapterNumber,
      title: sanitizeNexusLMText(object.title.trim()) || `Chapter ${input.chapterNumber}`,
      intro: "",
      epigraph: normalizeText(object.epigraph.trim()),
      sections,
      forwardQuestion: normalizeText(object.forwardQuestion.trim()),
      keyTakeaways: object.keyTakeaways.map((value) => normalizeText(String(value))),
      reflectionQuestions: object.reflectionQuestions.map((value) => normalizeText(String(value))),
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
