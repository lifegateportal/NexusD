import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { z } from "zod";
import { deepSeekModel, deepSeekReasonerModel } from "@/lib/ai-providers";

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
  transcripts: z.array(z.object({ label: z.string().min(1).max(200), text: z.string().max(250000) })).max(20),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(8000) })).max(14).optional(),
}).superRefine((value, context) => {
  const totalCharacters = value.transcripts.reduce((sum, transcript) => sum + transcript.text.length, 0);
  if (totalCharacters > 1000000) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Transcript context is too large. Reduce the number or size of source files." });
  }
});

type Source = { id: string; label: string; excerpt: string; score: number };

function chunkTranscript(label: string, text: string): Source[] {
  const paragraphs = text.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const chunks: Source[] = [];
  let current = "";
  let index = 0;

  for (const paragraph of paragraphs.length > 0 ? paragraphs : [text]) {
    if ((current.length + paragraph.length) > 1400 && current) {
      chunks.push({ id: `${label}-${index}`, label, excerpt: current.slice(0, 1600), score: 0 });
      index += 1;
      current = "";
    }
    current += `${current ? "\n\n" : ""}${paragraph}`;
  }
  if (current) chunks.push({ id: `${label}-${index}`, label, excerpt: current.slice(0, 1600), score: 0 });
  return chunks;
}

function retrieveSources(transcripts: Array<{ label: string; text: string }>, query: string): Source[] {
  const terms = query.toLowerCase().split(/[^a-z0-9']+/).filter((term) => term.length > 2);
  const sources = transcripts.flatMap(({ label, text }) => chunkTranscript(label, text));
  for (const source of sources) {
    const haystack = source.excerpt.toLowerCase();
    source.score = terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
  }
  return sources
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
    .slice(0, 6)
    .map(({ score, ...source }) => ({ ...source, score }));
}

export async function POST(request: NextRequest) {
  let input: z.infer<typeof RequestSchema>;
  try {
    input = RequestSchema.parse(await request.json() as unknown);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid NexusLM request." }, { status: 400 });
  }

  const sources = retrieveSources(input.transcripts, input.query);
  const sourceContext = sources.length > 0
    ? sources.map((source) => `[${source.id}] ${source.label}\n${source.excerpt}`).join("\n\n---\n\n")
    : "No transcript excerpts matched. Say that clearly and do not invent transcript evidence.";
  const chapterContext = input.book.chapters.map((chapter) => `${chapter.number}. ${chapter.title}`).join("\n");
  const history = (input.history ?? []).map((message) => `${message.role.toUpperCase()}: ${message.content}`).join("\n");

  try {
    const { text } = await generateText({
      model: input.mode === "socratic" ? deepSeekReasonerModel : deepSeekModel,
      ...(input.mode === "ask" ? { temperature: 0.2 } : {}),
      maxTokens: 2200,
      system: `You are NexusLM, a source-grounded book companion. The active persona is ${input.persona}.
The book is "${input.book.title}".
Use only the supplied transcript excerpts for claims about the author's teaching. Cite supporting excerpts inline as [source-id]. If the excerpts do not support an answer, say so. Do not fabricate quotations.
${input.mode === "socratic" ? "This is Socratic Vetting mode. Produce a detailed, actionable vetting brief with these headings: Diagnosis; Evidence and assumptions; Proposed fixes; Chapter implementation plan; Questions requiring the author's decision. For every proposed fix, explain the problem it solves and the exact change a new chapter should make. Do not stop at questions or general criticism." : "This is Ask mode: answer directly, distinguish transcript evidence from interpretation, and cite sources."}`,
      prompt: `CHAPTER OUTLINE:\n${chapterContext || "No chapter outline available."}\n\nTRANSCRIPT SOURCES:\n${sourceContext}\n\nRECENT CONVERSATION:\n${history || "None"}\n\nUSER QUESTION:\n${input.query}`,
    });
    return NextResponse.json({ answer: text, sources: sources.map(({ score: _score, ...source }) => source) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "NexusLM could not answer." }, { status: 500 });
  }
}
