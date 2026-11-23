import { generateObject } from "ai";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deepSeekModel } from "@/lib/ai-providers";
import { LibraryVideoSegmentSchema } from "@/lib/schemas/library-video";
import { TrailerSuggestionResponseSchema } from "@/lib/schemas/trailer";

export const runtime = "nodejs";
export const maxDuration = 30;

const RequestSchema = z.object({
  title: z.string().trim().max(200).default(""),
  durationSeconds: z.number().finite().positive().max(3600),
  segments: z.array(LibraryVideoSegmentSchema).min(1).max(20000),
  instructions: z.string().trim().max(4000).default(""),
}).strict().refine(
  (input) => input.segments.every(
    (segment) => segment.endSeconds > segment.startSeconds
      && segment.endSeconds <= input.durationSeconds,
  ),
  { message: "Transcript segments must stay inside the source duration.", path: ["segments"] },
).refine(
  (input) => input.segments.reduce((total, segment) => total + segment.text.length, 0) <= 500_000,
  { message: "The transcript exceeds the trailer analysis limit.", path: ["segments"] },
);

const CandidateSchema = z.object({
  candidateId: z.number().int().min(1).max(36),
  title: z.string().trim().min(1).max(100),
  hook: z.string().trim().min(1).max(240),
  reason: z.string().trim().min(1).max(400),
}).strict();

const GeneratedSchema = z.object({
  suggestions: z.array(CandidateSchema).min(1).max(8),
}).strict();

type Candidate = {
  id: number;
  startSeconds: number;
  endSeconds: number;
  excerpt: string;
};

function buildCandidates(segments: z.infer<typeof LibraryVideoSegmentSchema>[]): Candidate[] {
  const targets = [4, 6, 8, 12, 16, 20, 30];
  const candidates = new Map<string, Omit<Candidate, "id">>();
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
      if (endSeconds - startSeconds > 35) continue;
      const key = `${startIndex}:${endIndex}`;
      if (!candidates.has(key)) {
        const excerpt = segments.slice(startIndex, endIndex + 1)
          .map((segment) => segment.text)
          .join(" ");
        candidates.set(key, {
          startSeconds,
          endSeconds,
          excerpt: excerpt.length > 240 ? `${excerpt.slice(0, 170)} ... ${excerpt.slice(-70)}` : excerpt,
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
    return NextResponse.json({ error: "Configure Director authentication before curating trailer moments." }, { status: 503 });
  }

  let input: z.infer<typeof RequestSchema>;
  try {
    input = RequestSchema.parse(await request.json() as unknown);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid trailer curation request." },
      { status: 400 },
    );
  }

  const candidates = buildCandidates(input.segments);
  if (candidates.length === 0) {
    return NextResponse.json({ error: "No usable trailer moments were found in this transcript." }, { status: 422 });
  }

  const candidateText = candidates.map((candidate) =>
    `CANDIDATE ${candidate.id} (${candidate.startSeconds.toFixed(2)}–${candidate.endSeconds.toFixed(2)}): ${candidate.excerpt}`,
  ).join("\n");
  try {
    const generated = await generateObject({
      model: deepSeekModel,
      schema: GeneratedSchema,
      maxTokens: 2500,
      temperature: 0.3,
      system: "You are a promotional trailer editor. Select 3 to 8 short, compelling moments that form a clear emotional arc: opening hook, meaningful build, and a memorable close. Use only the supplied candidate IDs and their exact timestamps. Order moments for a persuasive trailer, but do not alter timing or invent transcript facts. Keep titles concise and hooks faithful to the spoken words. Prefer complete thoughts with natural beginnings and endings.",
      prompt: `SOURCE: ${input.title || "Untitled video"}\nDURATION: ${input.durationSeconds.toFixed(1)} seconds\nEDITOR DIRECTION: ${input.instructions || "Create a compelling, concise promotional trailer."}\n\nVALID MOMENT CANDIDATES:\n${candidateText}`,
    });
    const parsed = GeneratedSchema.safeParse(generated.object);
    if (!parsed.success) throw new Error("The AI returned an invalid trailer moment plan.");
    const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const suggestions = parsed.data.suggestions.flatMap((suggestion) => {
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
    const response = TrailerSuggestionResponseSchema.safeParse({ suggestions });
    if (!response.success) {
      return NextResponse.json({ error: "The AI did not select valid trailer moments. Try again." }, { status: 502 });
    }
    return NextResponse.json(response.data, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not curate trailer moments." },
      { status: 502 },
    );
  }
}
