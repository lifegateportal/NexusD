import { z } from "zod";
import { MAX_VIDEO_SOURCE_FILE_BYTES } from "@/lib/schemas/video-short";
import { LibraryVideoSegmentSchema } from "@/lib/schemas/library-video";

const DeepgramWordSchema = z.object({
  word: z.string().optional(),
  punctuated_word: z.string().optional(),
  start: z.number().finite().min(0).optional(),
  end: z.number().finite().min(0).optional(),
}).passthrough();

const DeepgramResponseSchema = z.object({
  err_msg: z.string().optional(),
  message: z.string().optional(),
  results: z.object({
    channels: z.array(z.object({
      alternatives: z.array(z.object({
        transcript: z.string().optional(),
        words: z.array(DeepgramWordSchema).optional(),
      }).passthrough()).default([]),
    }).passthrough()).default([]),
    utterances: z.array(z.object({
      start: z.number().finite().min(0).optional(),
      end: z.number().finite().min(0).optional(),
      transcript: z.string().optional(),
    }).passthrough()).optional(),
  }).optional(),
}).passthrough();

const DeepgramTokenSchema = z.object({ apiKey: z.string().min(1) });
const ErrorResponseSchema = z.object({ error: z.string().min(1) });

function videoContentType(file: File): "video/mp4" | "video/webm" {
  if (file.type === "video/mp4" || file.type === "video/webm") return file.type;
  const filename = file.name.toLowerCase();
  if (filename.endsWith(".mp4")) return "video/mp4";
  if (filename.endsWith(".webm")) return "video/webm";
  throw new Error("Choose an MP4 or WebM source video.");
}

function errorMessage(body: unknown, fallback: string): string {
  const parsed = ErrorResponseSchema.safeParse(body);
  return parsed.success ? parsed.data.error : fallback;
}

export async function transcribeVideoSource(file: File) {
  if (file.size === 0 || file.size > MAX_VIDEO_SOURCE_FILE_BYTES) {
    throw new Error("Source videos must be non-empty and 500 MB or smaller.");
  }
  const contentType = videoContentType(file);

  const tokenResponse = await fetch("/api/transcribe-token", {
    cache: "no-store",
  });
  const tokenBody: unknown = await tokenResponse.json();
  if (!tokenResponse.ok) {
    throw new Error(errorMessage(tokenBody, `Could not get Deepgram credentials (HTTP ${tokenResponse.status}).`));
  }
  const token = DeepgramTokenSchema.safeParse(tokenBody);
  if (!token.success) throw new Error("Deepgram credentials endpoint returned an invalid response.");

  const params = new URLSearchParams({
    model: "nova-3",
    smart_format: "true",
    punctuate: "true",
    paragraphs: "true",
    language: "en",
    utterances: "true",
  });
  const response = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: "POST",
    headers: {
      Authorization: `Token ${token.data.apiKey}`,
      "Content-Type": contentType,
    },
    body: file,
  });

  let responseBody: unknown;
  try {
    responseBody = await response.json() as unknown;
  } catch {
    throw new Error(`Deepgram returned an unreadable response (HTTP ${response.status}).`);
  }
  const result = DeepgramResponseSchema.safeParse(responseBody);
  if (!response.ok) {
    const detail = result.success
      ? result.data.err_msg ?? result.data.message ?? `Deepgram returned HTTP ${response.status}.`
      : `Deepgram returned HTTP ${response.status}.`;
    throw new Error(detail);
  }
  if (!result.success) throw new Error("Deepgram returned an invalid transcription response.");

  const alternative = result.data.results?.channels[0]?.alternatives[0];
  if (!alternative?.transcript?.trim()) {
    throw new Error("Deepgram did not detect speech in this source video.");
  }

  let segments = (result.data.results?.utterances ?? []).flatMap((utterance) => {
    const text = utterance.transcript?.trim() ?? "";
    if (!text || utterance.start === undefined || utterance.end === undefined) return [];
    return [{ startSeconds: utterance.start, endSeconds: utterance.end, text }];
  });

  if (segments.length === 0) {
    let group: { startSeconds: number; endSeconds: number; text: string } | null = null;
    for (const word of alternative.words ?? []) {
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
    throw new Error("Deepgram returned text without timestamps. Retry with a supported MP4 or WebM source.");
  }
  return z.array(LibraryVideoSegmentSchema).parse(segments);
}
