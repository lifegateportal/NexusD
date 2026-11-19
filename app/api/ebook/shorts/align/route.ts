import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { LibraryVideoSegmentSchema } from "@/lib/schemas/library-video";
import { alignTranscriptWordTimings } from "@/lib/short-transcript-edits";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const RequestSchema = z.object({
  captions: z.array(LibraryVideoSegmentSchema).min(1).max(5000),
  startSeconds: z.number().finite().min(0),
  endSeconds: z.number().finite().positive(),
}).strict().refine(
  (request) => request.endSeconds > request.startSeconds
    && request.endSeconds - request.startSeconds <= 180,
  { message: "The short range must be between 0 and 180 seconds.", path: ["endSeconds"] },
);

const DeepgramResponseSchema = z.object({
  err_msg: z.string().optional(),
  results: z.object({
    channels: z.array(z.object({
      alternatives: z.array(z.object({
        words: z.array(z.object({
          word: z.string().optional(),
          punctuated_word: z.string().optional(),
          start: z.number().finite().min(0).optional(),
          end: z.number().finite().min(0).optional(),
        }).passthrough()).optional(),
      }).passthrough()).default([]),
    }).passthrough()).default([]),
  }).optional(),
}).passthrough();

export async function POST(request: NextRequest) {
  if (!process.env.AUTH_PASSWORD || !process.env.AUTH_COOKIE_SECRET) {
    return NextResponse.json(
      { error: "Configure Director authentication before aligning transcript timing." },
      { status: 503 },
    );
  }
  if (!env.DEEPGRAM_API_KEY) {
    return NextResponse.json({ error: "DEEPGRAM_API_KEY is not configured." }, { status: 503 });
  }

  let file: File;
  let input: z.infer<typeof RequestSchema>;
  try {
    const form = await request.formData();
    const source = form.get("file");
    const metadata = form.get("metadata");
    if (!(source instanceof File) || typeof metadata !== "string") {
      return NextResponse.json({ error: "Select a source video and provide the transcript range." }, { status: 400 });
    }
    file = source;
    input = RequestSchema.parse(JSON.parse(metadata) as unknown);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid transcript alignment request." },
      { status: 400 },
    );
  }

  const contentType = file.type || (
    file.name.toLocaleLowerCase().endsWith(".webm") ? "video/webm" : "video/mp4"
  );
  if (!["video/mp4", "video/webm"].includes(contentType)) {
    return NextResponse.json({ error: "Choose an MP4 or WebM source video." }, { status: 415 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "The source video is empty." }, { status: 400 });
  }
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json(
      { error: "Precise alignment supports source videos up to 100 MB. Larger files can keep using estimated timing." },
      { status: 413 },
    );
  }

  try {
    const params = new URLSearchParams({
      model: "nova-3",
      smart_format: "true",
      punctuate: "true",
      utterances: "true",
      language: "en",
    });
    const response = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
      method: "POST",
      headers: {
        Authorization: `Token ${env.DEEPGRAM_API_KEY}`,
        "Content-Type": contentType,
      },
      body: Buffer.from(await file.arrayBuffer()),
      signal: AbortSignal.timeout(110_000),
    });
    const responseBody: unknown = await response.json();
    const result = DeepgramResponseSchema.safeParse(responseBody);
    if (!response.ok) {
      const detail = result.success
        ? result.data.err_msg ?? `Deepgram returned HTTP ${response.status}.`
        : `Deepgram returned HTTP ${response.status} with an invalid error response.`;
      throw new Error(detail);
    }
    if (!result.success) throw new Error("Deepgram returned an invalid word-timing response.");

    const audioWords = (result.data.results?.channels[0]?.alternatives[0]?.words ?? [])
      .flatMap((word) => {
        const text = word.punctuated_word ?? word.word ?? "";
        return text && word.start !== undefined && word.end !== undefined && word.end > word.start
          ? [{ text, startSeconds: word.start, endSeconds: word.end }]
          : [];
      });
    const alignment = alignTranscriptWordTimings(
      input.captions,
      audioWords,
      input.startSeconds,
      input.endSeconds,
    );
    const minimumMatches = Math.max(1, Math.ceil(alignment.totalWords * 0.5));
    if (alignment.wordTimings.length < minimumMatches) {
      return NextResponse.json(
        { error: "The uploaded source did not align reliably with enough transcript words. The existing transcript and timing were left unchanged." },
        { status: 422 },
      );
    }
    return NextResponse.json({
      wordTimings: alignment.wordTimings,
      matchedWords: alignment.wordTimings.length,
      totalWords: alignment.totalWords,
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not align transcript timing." },
      { status: 502 },
    );
  }
}
