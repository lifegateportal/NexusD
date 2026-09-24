import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { z } from "zod";
import { deepSeekModel, deepSeekReasonerModel } from "@/lib/ai-providers";
import { ChapterDraftSchema, FrontBackMatterSchema } from "@/lib/schemas/ebook";

export const runtime = "nodejs";
export const maxDuration = 90;

const RequestSchema = z.object({
  query: z.string().min(1).max(4000),
  mode: z.enum(["ask", "socratic"]),
  persona: z.string().min(1).max(80),
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
  query: string
): Source[] {
  const manuscriptSources = scoreSources(manuscript ? chunkManuscript(manuscript) : [], query);
  const transcriptSources = scoreSources(transcripts.flatMap(({ label, text }) => chunkTranscript(label, text)), query);
  return [...manuscriptSources.slice(0, 8), ...transcriptSources.slice(0, 4)];
}

export async function POST(request: NextRequest) {
  let input: z.infer<typeof RequestSchema>;
  try {
    input = RequestSchema.parse(await request.json() as unknown);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid NexusLM request." }, { status: 400 });
  }

  const sources = retrieveSources(input.transcripts, input.manuscript, input.query);
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

  try {
    const { text } = await generateText({
      model: input.mode === "socratic" ? deepSeekReasonerModel : deepSeekModel,
      ...(input.mode === "ask" ? { temperature: 0.2 } : {}),
      maxRetries: 2,
      maxTokens: input.mode === "socratic" ? 8000 : 2200,
      system: `You are NexusLM, a source-grounded book companion. The active persona is ${input.persona}.
The book is "${input.book.title}".
    The written manuscript is the primary audit target. Use the supplied WRITTEN MANUSCRIPT EXCERPTS to assess what the book actually says, demonstrates, defines, and sequences. Use transcript excerpts only as supporting provenance for the author's underlying teaching. Cite supporting excerpts inline as [source-id], distinguish manuscript evidence from transcript evidence, and do not claim you cannot see the manuscript when manuscript excerpts are supplied. If the supplied excerpts do not support an answer, say so. Do not fabricate quotations.
${input.mode === "socratic" ? "This is Socratic Vetting mode. Produce a detailed, actionable vetting brief with these headings: Diagnosis; Evidence and assumptions; Proposed fixes; Chapter implementation plan; Questions requiring the author's decision. For every proposed fix, explain the problem it solves and the exact change a new chapter should make. Do not stop at questions or general criticism." : "This is Ask mode: answer directly, distinguish transcript evidence from interpretation, and cite sources."}`,
      prompt: `CHAPTER OUTLINE:\n${chapterContext || "No chapter outline available."}\n\nTRANSCRIPT SOURCES:\n${sourceContext}\n\nRECENT CONVERSATION:\n${history || "None"}\n\nUSER QUESTION:\n${input.query}`,
    });
    const answer = text.trim();
    if (!answer) {
      return NextResponse.json({ error: "The reasoning model returned no final vetting response. Please try again." }, { status: 502 });
    }
    return NextResponse.json({ answer, sources: sources.map(({ score: _score, ...source }) => source) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "NexusLM could not answer." }, { status: 500 });
  }
}
