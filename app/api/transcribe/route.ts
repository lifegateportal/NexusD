import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { MAX_VIDEO_SOURCE_FILE_BYTES } from "@/lib/schemas/video-short";

export const runtime = "nodejs";
export const maxDuration = 300;

const DeepgramResponseSchema = z.object({
  err_msg: z.string().optional(),
  message: z.string().optional(),
  results: z.object({
    channels: z.array(z.object({
      detected_language: z.string().optional(),
      alternatives: z.array(z.object({
        transcript: z.string().optional(),
        words: z.array(z.object({
          word: z.string().optional(),
          punctuated_word: z.string().optional(),
          start: z.number().finite().min(0).optional(),
          end: z.number().finite().min(0).optional(),
        }).passthrough()).optional(),
      }).passthrough()).default([]),
    }).passthrough()).default([]),
    utterances: z.array(z.object({
      start: z.number().finite().min(0).optional(),
      end: z.number().finite().min(0).optional(),
      transcript: z.string().optional(),
    }).passthrough()).optional(),
  }).optional(),
}).passthrough();

export async function POST(request: NextRequest) {
  if (!env.DEEPGRAM_API_KEY) {
    return NextResponse.json(
      { error: "DEEPGRAM_API_KEY not configured" },
      { status: 503 }
    );
  }

  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }
    if (file.size === 0) {
      return NextResponse.json({ error: "The selected media file is empty." }, { status: 400 });
    }
    if (file.size > MAX_VIDEO_SOURCE_FILE_BYTES) {
      return NextResponse.json({ error: "Media files must be 500 MB or smaller." }, { status: 413 });
    }

    const mimeType = file.type === "video/mp4" || file.type === "video/webm"
      ? file.type
      : file.name.toLowerCase().endsWith(".mp4")
        ? "video/mp4"
        : file.name.toLowerCase().endsWith(".webm")
          ? "video/webm"
          : null;
    if (!mimeType) {
      return NextResponse.json({ error: "Choose an MP4 or WebM source video." }, { status: 415 });
    }

    const params = new URLSearchParams({
      model: "nova-2",
      smart_format: "true",
      punctuate: "true",
      paragraphs: "true",
      utterances: "true",
      language: "multi",
      detect_language: "true",
    });
    const requestOptions: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: {
        Authorization: `Token ${env.DEEPGRAM_API_KEY}`,
        "Content-Type": mimeType,
      },
      body: file.stream(),
      duplex: "half",
      signal: AbortSignal.timeout(280_000),
    };
    const response = await fetch(`https://api.deepgram.com/v1/listen?${params}`, requestOptions);
    const responseBody: unknown = await response.json();
    const parsedResponse = DeepgramResponseSchema.safeParse(responseBody);
    if (!response.ok) {
      const detail = parsedResponse.success
        ? parsedResponse.data.err_msg ?? parsedResponse.data.message ?? `Deepgram returned HTTP ${response.status}.`
        : `Deepgram returned HTTP ${response.status} with an invalid error response.`;
      throw new Error(detail);
    }
    if (!parsedResponse.success) {
      throw new Error("Deepgram returned an invalid transcription response.");
    }
    const result = parsedResponse.data;

    const transcript =
      result?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";

    if (!transcript.trim()) {
      return NextResponse.json(
        { error: "Deepgram returned an empty transcript" },
        { status: 422 }
      );
    }

    const utterances = result?.results?.utterances ?? [];
    let segments = utterances.flatMap((utterance) => {
      const text = utterance.transcript?.trim() ?? "";
      if (!text || utterance.start === undefined || utterance.end === undefined) return [];
      return [{
        startSeconds: utterance.start,
        endSeconds: utterance.end,
        text,
      }];
    });

    if (segments.length === 0) {
      const words = result?.results?.channels?.[0]?.alternatives?.[0]?.words ?? [];
      let group: { startSeconds: number; endSeconds: number; text: string } | null = null;
      for (const word of words) {
        const text = word.punctuated_word ?? word.word ?? "";
        if (!text || word.start === undefined || word.end === undefined) continue;
        if (!group || word.start - group.startSeconds > 12 || group.text.split(/\s+/).length >= 30) {
          if (group) segments.push(group);
          group = { startSeconds: word.start, endSeconds: word.end, text };
        } else {
          group.endSeconds = word.end;
          group.text += ` ${text}`;
        }
      }
      if (group) segments.push(group);
    }

    if (segments.length === 0) {
      return NextResponse.json(
        { error: "Speech was detected, but the transcription service returned no word timestamps for this file. Try uploading an audio-only file." },
        { status: 422 }
      );
    }

    return NextResponse.json({ transcript, segments }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      {
        error: err instanceof Error && err.name === "TimeoutError"
          ? "Deepgram transcription timed out. Try a smaller/compressed video or retry."
          : `Transcription failed: ${message}`,
      },
      { status: err instanceof Error && err.name === "TimeoutError" ? 504 : 500 }
    );
  }
}
