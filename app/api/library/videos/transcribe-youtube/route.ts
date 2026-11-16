import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import youtubeDl from "youtube-dl-exec";
import { LibraryVideoSegmentSchema } from "@/lib/schemas/library-video";

export const runtime = "nodejs";
export const maxDuration = 180;

const RequestSchema = z.object({
  url: z.string().url().max(2000),
}).strict();

const DeepgramResponseSchema = z.object({
  err_msg: z.string().optional(),
  results: z.object({
    channels: z.array(z.object({
      alternatives: z.array(z.object({
        transcript: z.string().optional(),
      })).default([]),
    })).default([]),
    utterances: z.array(z.object({
      start: z.number().finite().min(0).optional(),
      end: z.number().finite().min(0).optional(),
      transcript: z.string().optional(),
    })).optional(),
  }).optional(),
}).passthrough();

function extractYouTubeVideoId(input: string): string | null {
  try {
    const url = new URL(input);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    let id: string | null = null;
    if (host === "youtu.be") id = url.pathname.split("/").filter(Boolean)[0] ?? null;
    if (host === "youtube.com" || host === "m.youtube.com") {
      id = url.searchParams.get("v")
        ?? url.pathname.match(/^\/(?:embed|shorts)\/([A-Za-z0-9_-]{11})/)?.[1]
        ?? null;
    }
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  let url: string;
  try {
    url = RequestSchema.parse(await request.json() as unknown).url;
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid YouTube URL." },
      { status: 400 },
    );
  }

  const videoId = extractYouTubeVideoId(url);
  if (!videoId) {
    return NextResponse.json({ error: "Enter a valid YouTube video URL." }, { status: 400 });
  }
  if (!env.DEEPGRAM_API_KEY) {
    return NextResponse.json({ error: "Audio transcription is not configured on this server." }, { status: 503 });
  }

  try {
    const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
    let extractedUrl: Awaited<ReturnType<typeof youtubeDl>>;
    try {
      extractedUrl = await youtubeDl(canonicalUrl, {
        getUrl: true,
        format: "bestaudio/best",
        noPlaylist: true,
        noWarnings: true,
        quiet: true,
        socketTimeout: 20,
      }, { timeout: 45_000 });
    } catch {
      return NextResponse.json(
        { error: "Could not access this video's audio. Make sure it is publicly playable and not age- or region-restricted." },
        { status: 502 },
      );
    }

    if (typeof extractedUrl !== "string") {
      throw new Error("YouTube did not return an audio stream.");
    }
    const audioUrl = extractedUrl.trim().split(/\r?\n/)[0];
    if (!audioUrl) throw new Error("YouTube did not return an audio stream.");

    const audioHost = new URL(audioUrl);
    if (audioHost.protocol !== "https:" || !audioHost.hostname.endsWith(".googlevideo.com")) {
      throw new Error("The extracted audio URL was not a trusted YouTube media host.");
    }

    const params = new URLSearchParams({
      model: "nova-3",
      smart_format: "true",
      punctuate: "true",
      utterances: "true",
      language: "en",
    });
    const transcriptionResponse = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
      method: "POST",
      headers: {
        Authorization: `Token ${env.DEEPGRAM_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: audioUrl }),
      signal: AbortSignal.timeout(150_000),
    });
    const rawResponse: unknown = await transcriptionResponse.json();
    const parsedResponse = DeepgramResponseSchema.safeParse(rawResponse);
    if (!transcriptionResponse.ok) {
      throw new Error(
        parsedResponse.success
          ? parsedResponse.data.err_msg ?? `Audio transcription failed (HTTP ${transcriptionResponse.status}).`
          : `Audio transcription failed (HTTP ${transcriptionResponse.status}).`,
      );
    }
    if (!parsedResponse.success) {
      throw new Error("The transcription service returned an invalid response.");
    }

    const transcript = parsedResponse.data.results?.channels[0]?.alternatives[0]?.transcript?.trim() ?? "";
    const segments = LibraryVideoSegmentSchema.array().parse(
      (parsedResponse.data.results?.utterances ?? []).flatMap((utterance) => {
        const text = utterance.transcript?.trim() ?? "";
        if (!text || utterance.start === undefined || utterance.end === undefined) return [];
        return [{ startSeconds: utterance.start, endSeconds: utterance.end, text }];
      }),
    );
    if (!transcript || segments.length === 0) {
      return NextResponse.json(
        { error: "No timestamped speech was detected in this video's audio." },
        { status: 422 },
      );
    }

    return NextResponse.json({ transcript, segments, videoId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Audio transcription failed.";
    if (message.includes("audio stream") || message.includes("trusted YouTube")) {
      return NextResponse.json(
        { error: "Could not access this video's audio. It may be private, age-restricted, live, or blocked. Upload an authorized audio/video file instead." },
        { status: 502 },
      );
    }
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
