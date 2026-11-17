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
    candidateId: z.number().int().min(1).max(36),
    title: z.string().trim().min(1).max(100),
    hook: z.string().trim().min(1).max(240),
    reason: z.string().trim().min(1).max(400),
  }).strict()).min(1).max(6),
}).strict();

type ClipCandidate = {
  id: number;
  startSeconds: number;
  endSeconds: number;
  excerpt: string;
};

function buildClipCandidates(segments: z.infer<typeof LibraryVideoSegmentSchema>[]): ClipCandidate[] {
  const targets = [20, 35, 50, 70];
  const candidates = new Map<string, Omit<ClipCandidate, "id">>();

  for (let startIndex = 0; startIndex < segments.length; startIndex += 1) {
    const startSeconds = segments[startIndex].startSeconds;
    for (const target of targets) {
      let endIndex = startIndex;
      while (
        endIndex < segments.length
        && segments[endIndex].endSeconds - startSeconds < target
      ) {
        endIndex += 1;
      }
      if (endIndex >= segments.length) continue;

      const endSeconds = segments[endIndex].endSeconds;
      const duration = endSeconds - startSeconds;
      if (duration < 15 || duration > 90) continue;

      const key = `${startIndex}:${endIndex}`;
      if (!candidates.has(key)) {
        candidates.set(key, {
          startSeconds,
          endSeconds,
          excerpt: segments
            .slice(startIndex, endIndex + 1)
            .map((segment) => segment.text)
            .join(" ")
            .slice(0, 400),
        });
      }
    }
  }

  const allCandidates = [...candidates.values()];
  const limit = 36;
  const selected = allCandidates.length <= limit
    ? allCandidates
    : Array.from({ length: limit }, (_, index) =>
      allCandidates[Math.floor(index * (allCandidates.length - 1) / (limit - 1))],
    );
  return selected.map((candidate, index) => ({ id: index + 1, ...candidate }));
}

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

  const candidates = buildClipCandidates(input.segments);
  if (candidates.length === 0) {
    return NextResponse.json(
      { error: "No continuous 15–90 second clip range could be found in this transcript." },
      { status: 422 },
    );
  }

  const transcript = candidates
    .map((candidate) =>
      `CANDIDATE ${candidate.id} (${candidate.startSeconds.toFixed(2)}–${candidate.endSeconds.toFixed(2)}): ${candidate.excerpt}`,
    )
    .join("\n");
  if (transcript.length > 30000) {
    return NextResponse.json({ error: "Select a shorter transcript range before asking AI for short ideas." }, { status: 413 });
  }

  try {
    const result = await generateObject({
      model: deepSeekModel,
      schema: SuggestionSchema,
      maxTokens: 1100,
      temperature: 0.3,
      system: "You are a video editor. Rank the supplied valid 15–90 second transcript clip candidates. Return only candidate IDs that appear in the list, with an accurate short title, a hook based only on the spoken words, and a concise reason. Never invent or modify candidate IDs, text, or timings. Prefer a self-contained moment with a natural opening and ending; avoid music-only or unintelligible segments.",
      prompt: `VIDEO TITLE: ${input.title || "Untitled video"}\n\nVALID CLIP CANDIDATES:\n${transcript}`,
    });
    const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const suggestions = result.object.suggestions.flatMap((suggestion) => {
      const candidate = candidateById.get(suggestion.candidateId);
      if (!candidate) return [];
      return [{
        startSeconds: candidate.startSeconds,
        endSeconds: candidate.endSeconds,
        title: suggestion.title,
        hook: suggestion.hook,
        reason: suggestion.reason,
      }];
    });
    if (suggestions.length === 0) {
      return NextResponse.json({ error: "AI did not select one of the valid transcript clip options. Try again." }, { status: 502 });
    }
    return NextResponse.json({ suggestions });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "AI could not suggest short clips." },
      { status: 502 },
    );
  }
}
