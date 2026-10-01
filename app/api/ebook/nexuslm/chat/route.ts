import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { z } from "zod";
import { deepSeekModel, deepSeekReasonerModel } from "@/lib/ai-providers";
import { ChapterDraftSchema, FrontBackMatterSchema } from "@/lib/schemas/ebook";
import { NexusLMWritingStyleSchema, NEXUSLM_WRITING_STYLES } from "@/lib/nexuslm-writing-styles";
import { NexusLMAgentSchema } from "@/lib/nexuslm-agents";
import { NexusLMResponseLengthSchema, NEXUSLM_RESPONSE_LENGTHS, sanitizeNexusLMText } from "@/lib/nexuslm-response";
import { SCRIPTURE_FORMATTING_RULES } from "@/lib/scripture-formatter";

export const runtime = "nodejs";
export const maxDuration = 90;

const RequestSchema = z.object({
  query: z.string().min(1).max(4000),
  mode: z.enum(["ask", "socratic", "plan"]),
  persona: z.string().min(1).max(80),
  agent: NexusLMAgentSchema.default("NexusChat"),
  writingStyle: NexusLMWritingStyleSchema.default("book-prose"),
  responseLength: NexusLMResponseLengthSchema.default("default"),
  llmTemperature: z.number().min(0).max(1).optional(),
  book: z.object({
    title: z.string().max(2000),
    chapters: z.array(z.object({ number: z.number().int().positive(), title: z.string().max(300) })).max(100),
  }),
  manuscript: z.object({
    frontMatter: FrontBackMatterSchema,
    chapters: z.array(ChapterDraftSchema).max(100),
  }).nullable().optional(),
  transcripts: z.array(z.object({ label: z.string().min(1).max(200), text: z.string().max(250000) })).max(20),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(8000) })).max(14).optional(),
}).superRefine((value, context) => {
  const totalCharacters = value.transcripts.reduce((sum, transcript) => sum + transcript.text.length, 0);
  const manuscriptCharacters = value.manuscript ? JSON.stringify(value.manuscript).length : 0;
  if (totalCharacters > 1000000) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Transcript context is too large. Reduce the number or size of source files." });
  }
  if (manuscriptCharacters > 1500000) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Manuscript context is too large. Audit a smaller manuscript selection." });
  }
});

type Source = { id: string; label: string; excerpt: string; score: number };
const MAX_COMPLETE_CONTEXT_CHARACTERS = 180000;

function chunkText(idPrefix: string, label: string, text: string): Source[] {
  const paragraphs = text.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const chunks: Source[] = [];
  let current = "";
  let index = 0;

  for (const paragraph of paragraphs.length > 0 ? paragraphs : [text]) {
    if (paragraph.length > 1400) {
      if (current) {
        chunks.push({ id: `${idPrefix}-${index}`, label, excerpt: current.slice(0, 1600), score: 0 });
        index += 1;
        current = "";
      }
      for (let offset = 0; offset < paragraph.length; offset += 1400) {
        chunks.push({ id: `${idPrefix}-${index}`, label, excerpt: paragraph.slice(offset, offset + 1600), score: 0 });
        index += 1;
      }
      continue;
    }
    if ((current.length + paragraph.length) > 1400 && current) {
      chunks.push({ id: `${idPrefix}-${index}`, label, excerpt: current.slice(0, 1600), score: 0 });
      index += 1;
      current = "";
    }
    current += `${current ? "\n\n" : ""}${paragraph}`;
  }
  if (current) chunks.push({ id: `${idPrefix}-${index}`, label, excerpt: current.slice(0, 1600), score: 0 });
  return chunks;
}

function chunkTranscript(label: string, text: string): Source[] {
  return chunkText(`T-${label}`, label, text);
}

function chunkManuscript(manuscript: z.infer<typeof RequestSchema>["manuscript"]): Source[] {
  if (!manuscript) return [];

  const parts = [
    { label: "Manuscript · Preface", text: manuscript.frontMatter.preface },
    { label: "Manuscript · Introduction", text: manuscript.frontMatter.introduction },
    ...manuscript.chapters.flatMap((chapter) => [
      {
        label: `Manuscript · Chapter ${chapter.number} · ${chapter.title} · Intro`,
        text: chapter.intro,
      },
      ...chapter.sections.map((section) => ({
        label: `Manuscript · Chapter ${chapter.number} · ${chapter.title} · ${section.heading}`,
        text: section.body,
      })),
      {
        label: `Manuscript · Chapter ${chapter.number} · ${chapter.title} · Forward question`,
        text: chapter.forwardQuestion,
      },
    ]),
    { label: "Manuscript · Conclusion", text: manuscript.frontMatter.conclusion },
  ];

  return parts
    .filter((part) => part.text.trim())
    .flatMap((part, index) => chunkText(`M-${index}`, part.label, part.text));
}

function scoreSources(sources: Source[], query: string): Source[] {
  const terms = query.toLowerCase().split(/[^a-z0-9']+/).filter((term) => term.length > 2);
  for (const source of sources) {
    const haystack = source.excerpt.toLowerCase();
    source.score = terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
  }
  return sources
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
    .map((source) => ({ ...source }));
}

function retrieveSources(
  transcripts: Array<{ label: string; text: string }>,
  manuscript: z.infer<typeof RequestSchema>["manuscript"],
  query: string,
  mode: z.infer<typeof RequestSchema>["mode"]
): Source[] {
  const manuscriptSources = manuscript ? chunkManuscript(manuscript) : [];
  const transcriptSources = transcripts.flatMap(({ label, text }) => chunkTranscript(label, text));
  const completeSources = [...manuscriptSources, ...transcriptSources];
  if (completeSources.reduce((total, source) => total + source.excerpt.length, 0) <= MAX_COMPLETE_CONTEXT_CHARACTERS) {
    return completeSources;
  }

  if (mode === "plan") {
    const transcriptGroups = Array.from(
      transcriptSources.reduce((groups, source) => {
        const group = groups.get(source.label) ?? [];
        group.push(source);
        groups.set(source.label, group);
        return groups;
      }, new Map<string, Source[]>()).values()
    );
    const transcriptBudget = Math.max(1600, MAX_COMPLETE_CONTEXT_CHARACTERS - 20000);
    const groupBudget = Math.max(1600, Math.floor(transcriptBudget / Math.max(1, transcriptGroups.length)));
    const selectedTranscriptSources = transcriptGroups.flatMap((group) => {
      const selected: Source[] = [];
      let groupCharacters = 0;
      for (const source of group) {
        if (selected.length > 0 && groupCharacters + source.excerpt.length > groupBudget) break;
        selected.push(source);
        groupCharacters += source.excerpt.length;
      }
      return selected;
    });
    const selectedTranscriptCharacters = selectedTranscriptSources.reduce((total, source) => total + source.excerpt.length, 0);
    const remainingCharacters = MAX_COMPLETE_CONTEXT_CHARACTERS - selectedTranscriptCharacters;
    const selectedManuscriptSources: Source[] = [];
    let manuscriptCharacters = 0;
    for (const source of scoreSources(manuscriptSources, query)) {
      if (manuscriptCharacters + source.excerpt.length > remainingCharacters) break;
      selectedManuscriptSources.push(source);
      manuscriptCharacters += source.excerpt.length;
    }
    return [...selectedManuscriptSources, ...selectedTranscriptSources];
  }

  const rankedManuscriptSources = scoreSources(manuscriptSources, query);
  const rankedTranscriptSources = scoreSources(transcriptSources, query);
  return [...rankedManuscriptSources.slice(0, 8), ...rankedTranscriptSources.slice(0, 4)];
}

export async function POST(request: NextRequest) {
  let input: z.infer<typeof RequestSchema>;
  try {
    input = RequestSchema.parse(await request.json() as unknown);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid NexusLM request." }, { status: 400 });
  }

  const sources = retrieveSources(input.transcripts, input.manuscript, input.query, input.mode);
  const manuscriptSources = sources.filter((source) => source.id.startsWith("M-"));
  const transcriptSources = sources.filter((source) => source.id.startsWith("T-"));
  const sourceContext = [
    manuscriptSources.length > 0
      ? `WRITTEN MANUSCRIPT EXCERPTS:\n${manuscriptSources.map((source) => `[${source.id}] ${source.label}\n${source.excerpt}`).join("\n\n---\n\n")}`
      : "NO WRITTEN MANUSCRIPT TEXT WAS PROVIDED.",
    transcriptSources.length > 0
      ? `TRANSCRIPT EXCERPTS:\n${transcriptSources.map((source) => `[${source.id}] ${source.label}\n${source.excerpt}`).join("\n\n---\n\n")}`
      : "NO TRANSCRIPT EXCERPTS MATCHED.",
  ].join("\n\n==========\n\n");
  const chapterContext = input.book.chapters.map((chapter) => `${chapter.number}. ${chapter.title}`).join("\n");
  const history = (input.history ?? []).map((message) => `${message.role.toUpperCase()}: ${message.content}`).join("\n");
  const writingStyle = NEXUSLM_WRITING_STYLES[input.writingStyle];
  const responseLength = NEXUSLM_RESPONSE_LENGTHS[input.responseLength];
  const modeInstruction = input.mode === "plan"
    ? "This is Plan Whole Book mode. Use every uploaded transcript slot represented in the transcript context, synthesize the author's complete teaching arc, and produce a practical whole-book plan before drafting. Include the book promise, core thesis, target reader, chapter sequence, each chapter's purpose and source-grounded teaching beats, progression between chapters, uncovered material, and the recommended writing order. Distinguish supported source material from decisions or gaps that require the author's input. Do not draft full chapters."
    : input.mode === "socratic"
      ? "This is Socratic Vetting mode. Produce a detailed, actionable vetting brief with these headings: Diagnosis; Evidence and assumptions; Proposed fixes; Chapter implementation plan; Questions requiring the author's decision. For every proposed fix, explain the problem it solves and the exact change a new chapter should make. Do not stop at questions or general criticism."
      : "This is Ask mode: answer directly, distinguish transcript evidence from interpretation, and cite sources.";

  try {
    const temperature = input.llmTemperature ?? (input.agent === "nexusR1" ? 1 : input.mode === "ask" ? 0.2 : undefined);
    const generationRequest = {
      ...(temperature === undefined ? {} : { temperature }),
      maxRetries: 2,
      maxTokens: input.mode === "socratic" || input.mode === "plan" ? responseLength.chatSocraticTokens : responseLength.chatAskTokens,
      system: `You are NexusLM, a source-grounded book companion. The selected agent is ${input.agent}. The active persona is ${input.persona}.
The book is "${input.book.title}".
The requested presentation form is ${writingStyle.label}: ${writingStyle.instruction}
    The written manuscript is the primary audit target. Use the supplied WRITTEN MANUSCRIPT EXCERPTS to assess what the book actually says, demonstrates, defines, and sequences. Use transcript excerpts only as supporting provenance for the author's underlying teaching. Use the sources for grounding, but never expose source IDs, slot labels, bracketed retrieval markers, or internal routing labels in the final answer. If the supplied excerpts do not support an answer, say so. Do not fabricate quotations.
  ${modeInstruction}
  ${SCRIPTURE_FORMATTING_RULES}`,
      prompt: `RESPONSE LENGTH: ${responseLength.label}. ${responseLength.instruction}

CHAPTER OUTLINE:\n${chapterContext || "No chapter outline available."}\n\nTRANSCRIPT SOURCES:\n${sourceContext}\n\nRECENT CONVERSATION:\n${history || "None"}\n\nUSER QUESTION:\n${input.query}
`,
    };

    const { text } = await generateText({
      model: input.agent === "nexusR1" ? deepSeekReasonerModel : deepSeekModel,
      ...generationRequest,
    });
    if (!text.trim()) throw new Error("The selected model returned an empty response.");

    const answer = sanitizeNexusLMText(text);
    if (!answer) {
      return NextResponse.json({ error: "The reasoning model returned no final vetting response. Please try again." }, { status: 502 });
    }
    return NextResponse.json({ answer, sources: sources.map(({ score: _score, ...source }) => source) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "NexusLM could not answer." }, { status: 500 });
  }
}
