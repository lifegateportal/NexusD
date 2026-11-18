import { generateObject } from "ai";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deepSeekModel } from "@/lib/ai-providers";
import { LibraryVideoSegmentSchema } from "@/lib/schemas/library-video";
import { MAX_SHORT_DURATION_SECONDS } from "@/lib/schemas/video-short";

export const runtime = "nodejs";
export const maxDuration = 30;

const RequestSchema = z.object({
  title: z.string().trim().max(200).default(""),
  segments: z.array(LibraryVideoSegmentSchema).min(1).max(20000),
  instructions: z.string().trim().max(4000).default(""),
}).strict().refine(
  (input) => input.segments.every((segment) => segment.endSeconds > segment.startSeconds),
  { message: "Every transcript segment must end after it starts.", path: ["segments"] },
).refine(
  (input) => input.segments.reduce((total, segment) => total + segment.text.length, 0) <= 1_000_000,
  { message: "The transcript exceeds the AI analysis size limit.", path: ["segments"] },
);

const SuggestionSchema = z.object({
  sermonStartCandidateId: z.number().int().min(1).max(80).nullable(),
  sermonEndCandidateId: z.number().int().min(1).max(80).nullable(),
  suggestions: z.array(z.object({
    candidateId: z.number().int().min(1).max(36),
    title: z.string().trim().min(1).max(100),
    hook: z.string().trim().min(1).max(240),
    reason: z.string().trim().min(1).max(400),
  }).strict()).min(1).max(6),
}).strict();

type BoundaryCandidate = {
  id: number;
  startSeconds: number;
  endSeconds: number;
  excerpt: string;
};

type ClipCandidate = {
  id: number;
  startSeconds: number;
  endSeconds: number;
  excerpt: string;
};

function buildClipCandidates(segments: z.infer<typeof LibraryVideoSegmentSchema>[]): ClipCandidate[] {
  const targets = [20, 35, 50, 70, 90, 120, 150, MAX_SHORT_DURATION_SECONDS];
  const candidates = new Map<string, Omit<ClipCandidate, "id">>();
  const anchorCount = Math.min(120, segments.length);
  const anchors = Array.from({ length: anchorCount }, (_, index) =>
    Math.floor(index * (segments.length - 1) / Math.max(1, anchorCount - 1)),
  );

  for (const startIndex of anchors) {
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
      if (duration < 15 || duration > MAX_SHORT_DURATION_SECONDS) continue;

      const key = `${startIndex}:${endIndex}`;
      if (!candidates.has(key)) {
        const excerpt = segments
          .slice(startIndex, endIndex + 1)
          .map((segment) => segment.text)
          .join(" ");
        candidates.set(key, {
          startSeconds,
          endSeconds,
          excerpt: excerpt.length > 300
            ? `${excerpt.slice(0, 180)} ... ${excerpt.slice(-120)}`
            : excerpt,
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

function buildBoundaryCandidates(
  segments: z.infer<typeof LibraryVideoSegmentSchema>[],
): BoundaryCandidate[] {
  const count = Math.min(80, segments.length);
  const indexes = Array.from({ length: count }, (_, index) =>
    Math.floor(index * (segments.length - 1) / Math.max(1, count - 1)),
  );
  return indexes.map((segmentIndex, index) => ({
    id: index + 1,
    startSeconds: segments[segmentIndex].startSeconds,
    endSeconds: segments[segmentIndex].endSeconds,
    excerpt: segments
      .slice(Math.max(0, segmentIndex - 2), Math.min(segments.length, segmentIndex + 3))
      .map((segment) => segment.text)
      .join(" ")
      .slice(0, 120),
  }));
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
  const boundaryCandidates = buildBoundaryCandidates(input.segments);
  if (candidates.length === 0) {
    return NextResponse.json(
      { error: "No continuous 15-second to 3-minute clip range could be found in this transcript." },
      { status: 422 },
    );
  }

  const candidateText = candidates
    .map((candidate) =>
      `CANDIDATE ${candidate.id} (${candidate.startSeconds.toFixed(2)}–${candidate.endSeconds.toFixed(2)}): ${candidate.excerpt}`,
    )
    .join("\n");
  const boundaryText = boundaryCandidates
    .map((candidate) =>
      `BOUNDARY ${candidate.id} (${candidate.startSeconds.toFixed(2)}–${candidate.endSeconds.toFixed(2)}): ${candidate.excerpt}`,
    )
    .join("\n");

  try {
    const result = await generateObject({
      model: deepSeekModel,
      schema: SuggestionSchema,
      maxTokens: 1500,
      temperature: 0.2,
      system: "You are a sermon video editor. First identify where the main sermon/message begins and ends from the supplied transcript boundary excerpts, excluding introductions, announcements, and closing material when discernible. Select only supplied boundary IDs; return null for either boundary if the transcript does not make it clear. Then rank the supplied valid 15-second to 3-minute clip candidates. Return only candidate IDs that appear in the list, with an accurate short title, a hook based only on the spoken words, and a concise reason. Never invent or modify candidate IDs, transcript content, or timings. Prefer complete, self-contained thoughts with natural spoken openings and endings. Treat creator preferences as style guidance only; transcript evidence and valid candidate timing always take priority.",
      prompt: `VIDEO TITLE: ${input.title || "Untitled video"}\n\nCREATOR PREFERENCES:\n${input.instructions || "No additional preferences supplied."}\n\nTRANSCRIPT BOUNDARY OPTIONS (timestamps are exact segment boundaries):\n${boundaryText}\n\nVALID CLIP CANDIDATES:\n${candidateText}`,
    });
    const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const boundaryById = new Map(boundaryCandidates.map((candidate) => [candidate.id, candidate]));
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
    const sermonStart = result.object.sermonStartCandidateId === null
      ? null
      : boundaryById.get(result.object.sermonStartCandidateId);
    const sermonEnd = result.object.sermonEndCandidateId === null
      ? null
      : boundaryById.get(result.object.sermonEndCandidateId);
    const validSermonBounds = sermonStart && sermonEnd && sermonEnd.endSeconds > sermonStart.startSeconds;
    return NextResponse.json({
      videoStartSeconds: input.segments[0].startSeconds,
      videoEndSeconds: input.segments[input.segments.length - 1].endSeconds,
      sermonStartSeconds: validSermonBounds ? sermonStart.startSeconds : null,
      sermonEndSeconds: validSermonBounds ? sermonEnd.endSeconds : null,
      suggestions,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "AI could not suggest short clips." },
      { status: 502 },
    );
  }
}
