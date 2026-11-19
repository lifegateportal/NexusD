import { generateObject } from "ai";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deepSeekModel } from "@/lib/ai-providers";
import { LibraryVideoSegmentSchema } from "@/lib/schemas/library-video";
import { getTranscriptWords } from "@/lib/short-transcript-edits";

export const runtime = "nodejs";
export const maxDuration = 30;

const RequestSchema = z.object({
  segments: z.array(LibraryVideoSegmentSchema).min(1).max(5000),
}).strict();
const SuggestionSchema = z.object({
  segmentIndex: z.number().int().min(0).max(4999),
  wordIndex: z.number().int().min(0).max(49999),
  wordText: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(200),
}).strict();
const ResponseSchema = z.object({
  suggestions: z.array(SuggestionSchema).max(40),
}).strict();
const FILLER_WORDS = new Set(["um", "uh", "erm", "er", "hmm", "mm", "mmm"]);

function normalizeWord(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

export async function POST(request: NextRequest) {
  if (!process.env.AUTH_PASSWORD || !process.env.AUTH_COOKIE_SECRET) {
    return NextResponse.json(
      { error: "Configure Director authentication before requesting transcript cleanup suggestions." },
      { status: 503 },
    );
  }

  let input: z.infer<typeof RequestSchema>;
  try {
    input = RequestSchema.parse(await request.json() as unknown);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid cleanup suggestion request." },
      { status: 400 },
    );
  }
  const transcript = input.segments
    .map((segment, index) => `[${index}] ${segment.text}`)
    .join("\n");
  if (transcript.length > 30000) {
    return NextResponse.json({ error: "Shorten the transcript to 30,000 characters or fewer before requesting cleanup suggestions." }, { status: 413 });
  }

  try {
    const generated = await generateObject({
      model: deepSeekModel,
      schema: ResponseSchema,
      maxTokens: 1200,
      temperature: 0.1,
      system: "Review transcript text for clearly non-lexical spoken filler words only. Do not suggest deleting meaningful words, phrases, or content. Return exact segmentIndex and wordIndex values from the supplied transcript. If uncertain, return no suggestion. Reasons must be brief and factual.",
      prompt: `Suggest only obvious standalone spoken fillers from this transcript: um, uh, erm, er, hmm, mm, or mmm. Keep meaningful words, including words that merely resemble fillers, intact. Do not suggest pauses; timing gaps are detected separately.\n\nTRANSCRIPT:\n${transcript}`,
    });
    const parsed = ResponseSchema.safeParse(generated.object);
    if (!parsed.success) throw new Error("The cleanup agent returned an invalid response.");

    const suggestions = parsed.data.suggestions.filter((suggestion) => {
      const segment = input.segments[suggestion.segmentIndex];
      const word = segment && getTranscriptWords(segment.text)[suggestion.wordIndex];
      return word
        && word.text === suggestion.wordText
        && FILLER_WORDS.has(normalizeWord(word.text));
    }).filter((suggestion, index, list) =>
      list.findIndex((entry) =>
        entry.segmentIndex === suggestion.segmentIndex && entry.wordIndex === suggestion.wordIndex,
      ) === index,
    );
    return NextResponse.json({ suggestions }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "The cleanup agent could not review this transcript." },
      { status: 502 },
    );
  }
}
