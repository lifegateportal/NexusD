import { generateObject } from "ai";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deepSeekModel } from "@/lib/ai-providers";
import { env } from "@/lib/env";
import { LibraryVideoSegmentSchema } from "@/lib/schemas/library-video";
import { MAX_SHORT_DURATION_SECONDS, ShortAspectRatioSchema } from "@/lib/schemas/video-short";
import {
  ShortBrollSuggestionsResponseSchema,
  ShortMusicSuggestionsResponseSchema,
} from "@/lib/schemas/short-media";

export const runtime = "nodejs";
export const maxDuration = 30;

const RequestSchema = z.object({
  kind: z.enum(["broll", "music"]),
  title: z.string().trim().min(1).max(200),
  startSeconds: z.number().finite().min(0),
  endSeconds: z.number().finite().min(0),
  frameSlots: z.array(z.object({
    startSeconds: z.number().finite().min(0),
    endSeconds: z.number().finite().min(0),
    aspectRatio: ShortAspectRatioSchema,
  }).strict()).min(1).max(100),
  captions: z.array(LibraryVideoSegmentSchema).min(1).max(2000),
  instructions: z.string().trim().max(4000).default(""),
}).strict().superRefine((input, context) => {
  if (input.endSeconds <= input.startSeconds) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["endSeconds"], message: "Short end must be after its start." });
  }
  if (input.endSeconds - input.startSeconds > MAX_SHORT_DURATION_SECONDS) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["endSeconds"], message: "Shorts can be up to 3 minutes long." });
  }
  if (input.captions.some((caption) =>
    caption.endSeconds <= caption.startSeconds
    || caption.startSeconds < input.startSeconds
    || caption.endSeconds > input.endSeconds,
  )) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["captions"], message: "Transcript captions must be inside the short range." });
  }
  if (input.frameSlots.some((slot) =>
    slot.endSeconds <= slot.startSeconds
    || slot.startSeconds < input.startSeconds
    || slot.endSeconds > input.endSeconds,
  )) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["frameSlots"], message: "Frame slots must be inside the short range." });
  }
  if (input.captions.reduce((total, caption) => total + caption.text.length, 0) > 40000) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["captions"], message: "The short transcript exceeds the AI search limit." });
  }
});

const BrollPlanSchema = z.object({
  suggestions: z.array(z.object({
    candidateId: z.number().int().min(1).max(20),
    query: z.string().trim().min(2).max(120),
    reason: z.string().trim().min(1).max(400),
  }).strict()).min(1).max(4),
}).strict();

const MusicPlanSchema = z.object({
  queries: z.array(z.object({
    query: z.string().trim().min(2).max(120),
    reason: z.string().trim().min(1).max(400),
  }).strict()).min(1).max(3),
}).strict();

type BrollCandidate = {
  id: number;
  startSeconds: number;
  endSeconds: number;
  excerpt: string;
};

const PexelsFileSchema = z.object({
  file_type: z.string(),
  link: z.string().url(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
}).passthrough();

const PexelsVideoSchema = z.object({
  id: z.number().int(),
  url: z.string().url(),
  image: z.string().url(),
  duration: z.number().finite().positive().max(3600),
  user: z.object({ name: z.string().trim().min(1), url: z.string().url() }).passthrough(),
  video_files: z.array(PexelsFileSchema),
}).passthrough();

const PexelsResponseSchema = z.object({
  videos: z.array(PexelsVideoSchema),
}).passthrough();

const JamendoTrackSchema = z.object({
  id: z.union([z.string(), z.number().int()]),
  name: z.string().trim().min(1),
  artist_name: z.string().trim().min(1),
  artist_id: z.union([z.string(), z.number().int()]).optional(),
  duration: z.coerce.number().finite().positive().max(3600),
  audio: z.string().url(),
  shareurl: z.string().url(),
  image: z.string().optional(),
}).passthrough();

const JamendoResponseSchema = z.object({
  headers: z.object({
    status: z.string().optional(),
    error_message: z.string().optional(),
  }).passthrough().optional(),
  results: z.array(JamendoTrackSchema),
}).passthrough();

const PEXELS_LICENSE_URL = "https://www.pexels.com/license/";
const JAMENDO_LICENSE_URL = "https://licensing.jamendo.com/royalty-free-music-library";

function buildBrollCandidates(
  captions: z.infer<typeof LibraryVideoSegmentSchema>[],
  startSeconds: number,
  endSeconds: number,
): BrollCandidate[] {
  const anchorCount = Math.min(20, captions.length);
  const indexes = Array.from({ length: anchorCount }, (_, index) =>
    Math.floor(index * (captions.length - 1) / Math.max(1, anchorCount - 1)),
  );
  const candidates = new Map<number, Omit<BrollCandidate, "id">>();

  for (const index of indexes) {
    const anchor = captions[index];
    const start = Math.max(startSeconds, anchor.startSeconds);
    const end = Math.min(endSeconds, Math.max(anchor.endSeconds, start + 7));
    if (end - start < 2) continue;
    const excerpt = captions
      .filter((caption) => caption.startSeconds < end + 2 && caption.endSeconds > start - 2)
      .map((caption) => caption.text)
      .join(" ")
      .slice(0, 500);
    const key = Math.round(start * 10);
    if (!candidates.has(key)) candidates.set(key, { startSeconds: start, endSeconds: end, excerpt });
  }

  return [...candidates.values()].slice(0, 20).map((candidate, index) => ({
    id: index + 1,
    ...candidate,
  }));
}

function orientationFor(
  timeSeconds: number,
  frameSlots: z.infer<typeof RequestSchema>["frameSlots"],
): "portrait" | "landscape" | "square" {
  const slot = frameSlots.find((item) =>
    timeSeconds >= item.startSeconds && timeSeconds < item.endSeconds,
  ) ?? frameSlots[0];
  if (slot.aspectRatio === "1:1") return "square";
  return slot.aspectRatio === "16:9" ? "landscape" : "portrait";
}

function isHttpsUrlFromDomain(value: string, domain: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && (url.hostname === domain || url.hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

async function searchPexels(query: string, orientation: "portrait" | "landscape" | "square") {
  if (!env.PEXELS_API_KEY) throw new Error("Configure PEXELS_API_KEY to search web B-roll.");
  const url = new URL("https://api.pexels.com/videos/search");
  url.searchParams.set("query", query);
  url.searchParams.set("per_page", "4");
  url.searchParams.set("orientation", orientation);
  const response = await fetch(url, {
    headers: { Authorization: env.PEXELS_API_KEY },
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Pexels search failed (HTTP ${response.status}).`);
  const parsed = PexelsResponseSchema.safeParse(await response.json() as unknown);
  if (!parsed.success) throw new Error("Pexels returned an invalid video-search response.");
  return parsed.data.videos;
}

async function searchJamendo(query: string) {
  if (!env.JAMENDO_CLIENT_ID) throw new Error("Configure JAMENDO_CLIENT_ID to search instrumental music.");
  if (!env.JAMENDO_COMMERCIAL_USE_APPROVED) {
    throw new Error("Jamendo commercial/API approval is required before searching music for public Shorts.");
  }

  const url = new URL("https://api.jamendo.com/v3.0/tracks/");
  url.searchParams.set("client_id", env.JAMENDO_CLIENT_ID);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "4");
  url.searchParams.set("search", query);
  url.searchParams.set("vocalinstrumental", "instrumental");
  url.searchParams.set("prolicensing", "true");
  url.searchParams.set("ccnc", "false");
  url.searchParams.set("ccnd", "false");
  url.searchParams.set("ccsa", "false");
  url.searchParams.set("audioformat", "mp32");
  url.searchParams.set("include", "licenses");

  const response = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Jamendo search failed (HTTP ${response.status}).`);
  const parsed = JamendoResponseSchema.safeParse(await response.json() as unknown);
  if (!parsed.success) throw new Error("Jamendo returned an invalid instrumental-search response.");
  if (parsed.data.headers?.status && parsed.data.headers.status !== "success") {
    throw new Error("Jamendo could not complete the music search.");
  }
  return parsed.data.results;
}

export async function POST(request: NextRequest) {
  if (!process.env.AUTH_PASSWORD || !process.env.AUTH_COOKIE_SECRET) {
    return NextResponse.json({ error: "Configure Director authentication before searching Shorts media." }, { status: 503 });
  }

  let input: z.infer<typeof RequestSchema>;
  try {
    input = RequestSchema.parse(await request.json() as unknown);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid Shorts media-search request." },
      { status: 400 },
    );
  }

  if (input.kind === "broll" && !env.PEXELS_API_KEY) {
    return NextResponse.json({ error: "Configure PEXELS_API_KEY to search web B-roll." }, { status: 503 });
  }
  if (input.kind === "music" && (!env.JAMENDO_CLIENT_ID || !env.JAMENDO_COMMERCIAL_USE_APPROVED)) {
    return NextResponse.json(
      { error: "Configure JAMENDO_CLIENT_ID and confirm Jamendo commercial/API approval before searching music." },
      { status: 503 },
    );
  }

  try {
    const transcript = input.captions
      .map((caption) => `[${caption.startSeconds.toFixed(1)}-${caption.endSeconds.toFixed(1)}] ${caption.text}`)
      .join("\n");

    if (input.kind === "broll") {
      const candidates = buildBrollCandidates(input.captions, input.startSeconds, input.endSeconds);
      if (candidates.length === 0) {
        return NextResponse.json({ error: "No usable transcript moments were found for B-roll." }, { status: 422 });
      }
      const plan = await generateObject({
        model: deepSeekModel,
        schema: BrollPlanSchema,
        maxTokens: 1200,
        temperature: 0.3,
        system: "You are a sermon video editor finding relevant licensed stock-footage search terms. Select only supplied transcript candidate IDs and their exact timestamps. Give each a concise visual query suitable for Pexels and a short reason grounded in the transcript. Do not send images or video to the model, invent transcript facts, alter timings, or request copyrighted characters, brands, or specific artists.",
        prompt: `VIDEO: ${input.title}\nEDITOR PREFERENCES: ${input.instructions || "No additional preferences."}\nTRANSCRIPT:\n${transcript}\n\nVALID B-ROLL WINDOWS (choose up to four IDs):\n${candidates.map((candidate) =>
          `CANDIDATE ${candidate.id} (${candidate.startSeconds.toFixed(1)}-${candidate.endSeconds.toFixed(1)}): ${candidate.excerpt}`,
        ).join("\n")}`,
      });
      const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
      const planItems = plan.object.suggestions.flatMap((suggestion) => {
        const candidate = candidateById.get(suggestion.candidateId);
        return candidate ? [{ ...suggestion, candidate }] : [];
      });
      if (planItems.length === 0) {
        return NextResponse.json({ error: "AI did not select a valid transcript window for B-roll. Try again." }, { status: 502 });
      }

      const groups = await Promise.all(planItems.map(async (item) => {
        const videos = await searchPexels(
          item.query,
          orientationFor(item.candidate.startSeconds, input.frameSlots),
        );
        return videos.flatMap((video) => {
          if (!isHttpsUrlFromDomain(video.url, "pexels.com") || !isHttpsUrlFromDomain(video.user.url, "pexels.com")) return [];
          const file = video.video_files
            .filter((candidate) =>
              candidate.file_type === "video/mp4"
              && isHttpsUrlFromDomain(candidate.link, "videos.pexels.com"),
            )
            .sort((first, second) =>
              Math.abs(Math.max(first.width, first.height) - 1080)
              - Math.abs(Math.max(second.width, second.height) - 1080),
            )[0];
          if (!file) return [];
          const durationSeconds = Math.min(
            video.duration,
            item.candidate.endSeconds - item.candidate.startSeconds,
          );
          if (durationSeconds < 2) return [];
          return [{
            id: `pexels-${video.id}`,
            title: `Pexels clip by ${video.user.name}`,
            query: item.query,
            reason: item.reason,
            videoUrl: file.link,
            previewUrl: video.image,
            durationSeconds: video.duration,
            startSeconds: item.candidate.startSeconds,
            endSeconds: item.candidate.startSeconds + durationSeconds,
            providerPageUrl: video.url,
            creatorName: video.user.name,
            creatorUrl: video.user.url,
            licenseName: "Pexels License",
            licenseUrl: PEXELS_LICENSE_URL,
          }];
        });
      }));
      const uniqueSuggestions = [...new Map(groups.flat().map((item) => [item.id, item])).values()].slice(0, 12);
      if (uniqueSuggestions.length === 0) {
        return NextResponse.json({ error: "Pexels found no playable MP4 clips for these transcript moments." }, { status: 422 });
      }
      return NextResponse.json(ShortBrollSuggestionsResponseSchema.parse({ suggestions: uniqueSuggestions }), {
        headers: { "Cache-Control": "private, no-store" },
      });
    }

    const plan = await generateObject({
      model: deepSeekModel,
      schema: MusicPlanSchema,
      maxTokens: 800,
      temperature: 0.3,
      system: "You are a music supervisor. Suggest up to three short English search phrases for instrumental music that fits the sermon transcript and the creator's preferences. Use mood, tempo, and instrumentation terms only. Do not request vocals, copyrighted songs, artists, or brands.",
      prompt: `VIDEO: ${input.title}\nEDITOR PREFERENCES: ${input.instructions || "No additional preferences."}\nTRANSCRIPT:\n${transcript}`,
    });
    const groups = await Promise.all(plan.object.queries.map(async (item) => ({
      item,
      tracks: await searchJamendo(item.query),
    })));
    const musicSuggestions = [...new Map(groups.flatMap(({ item, tracks }) => tracks.map((track) => {
      const trackId = String(track.id);
      const artistId = track.artist_id === undefined ? "" : String(track.artist_id);
      const providerPageUrl = isHttpsUrlFromDomain(track.shareurl, "jamendo.com")
        ? track.shareurl
        : `https://www.jamendo.com/track/${trackId}`;
      const creatorUrl = artistId
        ? `https://www.jamendo.com/artist/${artistId}`
        : providerPageUrl;
      return [trackId, {
        id: `jamendo-${trackId}`,
        title: track.name,
        artistName: track.artist_name,
        query: item.query,
        reason: item.reason,
        audioUrl: track.audio,
        durationSeconds: track.duration,
        ...(track.image && isHttpsUrlFromDomain(track.image, "jamendo.com")
          ? { albumImageUrl: track.image }
          : {}),
        providerPageUrl,
        creatorUrl,
        licenseName: "Jamendo Pro single-track commercial license required",
        licenseUrl: JAMENDO_LICENSE_URL,
      }];
    }))).values()].slice(0, 12);
    if (musicSuggestions.length === 0) {
      return NextResponse.json({ error: "Jamendo found no instrumental tracks in its commercial licensing catalog for these suggestions." }, { status: 422 });
    }
    return NextResponse.json(ShortMusicSuggestionsResponseSchema.parse({ suggestions: musicSuggestions }), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not search licensed Shorts media." },
      { status: 502 },
    );
  }
}
