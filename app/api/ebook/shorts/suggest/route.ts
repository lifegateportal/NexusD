import { generateObject } from "ai";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deepSeekModel } from "@/lib/ai-providers";
import { LibraryVideoSegmentSchema } from "@/lib/schemas/library-video";

export const runtime = "nodejs";
export const maxDuration = 30;

const RequestSchema = z.object({
  title: z.string().trim().max(200).default(""),
  segments: z.array(LibraryVideoSegmentSchema).min(1).max(5000),
}).strict();

const SuggestionSchema = z.object({
  suggestions: z.array(z.object({
    startIndex: z.number().int().min(0),
    endIndex: z.number().int().min(0),
    title: z.string().trim().min(1).max(100),
    hook: z.string().trim().min(1).max(240),
    reason: z.string().trim().min(1).max(400),
  }).strict()).min(1).max(6),
}).strict();

export async function POST(request: NextRequest) {
  if (!process.env.AUTH_PASSWORD || !process.env.AUTH_COOKIE_SECRET) {
    return NextResponse.json({ error: "Configure Director authentication before suggesting video shorts." }, { status: 503 });
  }
  let input: z.infer<typeof RequestSchema>;
  try {
    input = RequestSchema.parse(await request.json() as unknown);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid transcript suggestion request." },
      { status: 400 },
    );
  }

  const transcript = input.segments
    .map((segment, index) => `${index}: ${segment.startSeconds.toFixed(2)}-${segment.endSeconds.toFixed(2)} ${segment.text}`)
    .join("\n");
  if (transcript.length > 30000) {
    return NextResponse.json({ error: "Select a shorter transcript range before asking AI for short ideas." }, { status: 413 });
  }

  try {
    const result = await generateObject({
      model: deepSeekModel,
      schema: SuggestionSchema,
      maxTokens: 1400,
      temperature: 0.3,
      system: "You are a video editor. Suggest concise, self-contained short-form clips using only the supplied timestamped transcript. Return segment indexes exactly as given; do not invent timestamps. Each clip should be 15 to 90 seconds, have a strong spoken hook, and end at a natural thought boundary.",
      prompt: `VIDEO TITLE: ${input.title || "Untitled video"}\n\nTRANSCRIPT SEGMENTS (index: start-end text):\n${transcript}`,
    });
    const suggestions = result.object.suggestions.flatMap((suggestion) => {
      const start = input.segments[suggestion.startIndex];
      const end = input.segments[suggestion.endIndex];
      if (!start || !end || suggestion.endIndex < suggestion.startIndex) return [];
      const duration = end.endSeconds - start.startSeconds;
      if (duration < 15 || duration > 90) return [];
      return [{
        startSeconds: start.startSeconds,
        endSeconds: end.endSeconds,
        title: suggestion.title,
        hook: suggestion.hook,
        reason: suggestion.reason,
      }];
    });
    if (suggestions.length === 0) {
      return NextResponse.json({ error: "AI did not return valid 15–90 second transcript-based clips. Try another transcript section." }, { status: 502 });
    }
    return NextResponse.json({ suggestions });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "AI could not suggest short clips." },
      { status: 502 },
    );
  }
}
