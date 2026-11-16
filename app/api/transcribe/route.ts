import { createClient } from "@deepgram/sdk";
import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const maxDuration = 120; // large files can take time

const MAX_FILE_BYTES = 100 * 1024 * 1024;

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
    if (file.size > MAX_FILE_BYTES) {
      return NextResponse.json({ error: "Media files must be 100 MB or smaller." }, { status: 413 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    // Map video containers to their audio equivalent so Deepgram accepts them.
    // iOS Files app reports MP4 sermon recordings as video/mp4 or video/quicktime.
    const VIDEO_TO_AUDIO: Record<string, string> = {
      "video/mp4": "audio/mp4",
      "video/quicktime": "audio/mp4",
      "video/x-m4v": "audio/mp4",
      "video/webm": "audio/webm",
      "video/ogg": "audio/ogg",
      "video/x-matroska": "audio/webm",
    };
    const rawMime = file.type || "";
    const mimeType = VIDEO_TO_AUDIO[rawMime] ?? (rawMime || "audio/mpeg");

    const deepgram = createClient(env.DEEPGRAM_API_KEY);

    const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
      buffer,
      {
        model: "nova-2",
        smart_format: true,
        punctuate: true,
        paragraphs: true,
        utterances: true,
        language: "en",
        mimetype: mimeType,
      }
    );

    if (error) throw new Error(error.message ?? "Deepgram error");

    const transcript =
      result?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";

    if (!transcript.trim()) {
      return NextResponse.json(
        { error: "Deepgram returned an empty transcript" },
        { status: 422 }
      );
    }

    const utterances = result?.results?.utterances ?? [];
    const segments = utterances.flatMap((utterance) => {
      const text = utterance.transcript?.trim() ?? "";
      if (!text || utterance.start === undefined || utterance.end === undefined) return [];
      return [{
        startSeconds: utterance.start,
        endSeconds: utterance.end,
        text,
      }];
    });

    if (segments.length === 0) {
      return NextResponse.json(
        { error: "Deepgram transcribed the media but did not return timestamps. Try another media file." },
        { status: 422 }
      );
    }

    return NextResponse.json({ transcript, segments }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: "Transcription failed", detail: message },
      { status: 500 }
    );
  }
}
