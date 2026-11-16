import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { NextRequest, NextResponse } from "next/server";
import youtubeDl from "youtube-dl-exec";
import { z } from "zod";
import { env } from "@/lib/env";
import { makeR2Client } from "@/lib/r2-storage";
import {
  DirectorVideoCatalogSchema,
  DirectorVideoSchema,
  LibraryVideoCatalogSchema,
  LibraryVideoRecordSchema,
  LibraryVideoSegmentSchema,
} from "@/lib/schemas/library-video";

export const runtime = "nodejs";
export const maxDuration = 300;

const CHANNEL_URL = "https://www.youtube.com/@lifegatebroadcast/videos";
const PRIVATE_CATALOG_KEY = "director/videos/index.json";
const PUBLISHED_CATALOG_KEY = "published/videos/index.json";
const VideoIdSchema = z.string().regex(/^[A-Za-z0-9_-]{11}$/);
const ActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("discover") }).strict(),
  z.object({ action: z.literal("process"), videoId: VideoIdSchema }).strict(),
  z.object({ action: z.literal("approve"), videoId: VideoIdSchema }).strict(),
  z.object({ action: z.literal("unpublish"), videoId: VideoIdSchema }).strict(),
  z.object({ action: z.literal("delete"), videoId: VideoIdSchema }).strict(),
]);
const DeepgramResponseSchema = z.object({
  err_msg: z.string().optional(),
  results: z.object({
    channels: z.array(z.object({
      alternatives: z.array(z.object({ transcript: z.string().optional() })).default([]),
    })).default([]),
    utterances: z.array(z.object({
      start: z.number().finite().min(0).optional(),
      end: z.number().finite().min(0).optional(),
      transcript: z.string().optional(),
    })).optional(),
  }).optional(),
}).passthrough();
const DiscoveryEntrySchema = z.object({
  id: z.string().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
  webpage_url: z.string().optional(),
  duration: z.number().optional(),
}).passthrough();
const DiscoveryResultSchema = z.object({
  entries: z.array(z.unknown()).optional(),
}).passthrough();

function isMissingObject(error: unknown): boolean {
  return error instanceof Error && ["NoSuchKey", "NotFound"].includes(error.name);
}

function assertStorageConfigured(): void {
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_BUCKET_NAME) {
    throw new Error("Configure Cloudflare R2 credentials and bucket in Nexus Director to manage video transcripts.");
  }
}

function directorAuthIsConfigured(): boolean {
  return Boolean(process.env.AUTH_PASSWORD && process.env.AUTH_COOKIE_SECRET);
}

async function readJsonObject(key: string): Promise<unknown | null> {
  assertStorageConfigured();
  try {
    const result = await makeR2Client().send(new GetObjectCommand({
      Bucket: env.R2_BUCKET_NAME,
      Key: key,
    }));
    const raw = await result.Body?.transformToString();
    if (!raw) throw new Error(`R2 object ${key} is empty.`);
    return JSON.parse(raw) as unknown;
  } catch (error) {
    if (isMissingObject(error)) return null;
    throw error;
  }
}

async function writeJsonObject(key: string, value: unknown, isPublic = false): Promise<void> {
  assertStorageConfigured();
  await makeR2Client().send(new PutObjectCommand({
    Bucket: env.R2_BUCKET_NAME,
    Key: key,
    Body: JSON.stringify(value),
    ContentType: "application/json",
    CacheControl: isPublic ? "public, max-age=60" : "private, no-store",
  }));
}

async function deleteObject(key: string): Promise<void> {
  assertStorageConfigured();
  await makeR2Client().send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET_NAME, Key: key }));
}

async function readPrivateCatalog(): Promise<z.infer<typeof DirectorVideoCatalogSchema>> {
  const raw = await readJsonObject(PRIVATE_CATALOG_KEY);
  if (raw) return DirectorVideoCatalogSchema.parse(raw);
  const oldPublic = await readJsonObject(PUBLISHED_CATALOG_KEY);
  if (!oldPublic) return { updatedAt: new Date().toISOString(), videos: [] };
  const published = LibraryVideoCatalogSchema.parse(oldPublic);
  return {
    updatedAt: published.updatedAt,
    videos: published.videos.map((video) => DirectorVideoSchema.parse({
      ...video,
      status: "published",
      updatedAt: video.addedAt,
      segments: [],
    })),
  };
}

async function readPublishedCatalog(): Promise<z.infer<typeof LibraryVideoCatalogSchema>> {
  const raw = await readJsonObject(PUBLISHED_CATALOG_KEY);
  return raw
    ? LibraryVideoCatalogSchema.parse(raw)
    : { updatedAt: new Date().toISOString(), videos: [] };
}

async function savePrivateCatalog(videos: z.infer<typeof DirectorVideoSchema>[]): Promise<z.infer<typeof DirectorVideoCatalogSchema>> {
  const catalog = DirectorVideoCatalogSchema.parse({ updatedAt: new Date().toISOString(), videos });
  await writeJsonObject(PRIVATE_CATALOG_KEY, catalog);
  return catalog;
}

function videoIdFromEntry(entry: z.infer<typeof DiscoveryEntrySchema>): string | null {
  const candidate = entry.id
    ?? entry.url?.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([A-Za-z0-9_-]{11})/)?.[1]
    ?? entry.webpage_url?.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([A-Za-z0-9_-]{11})/)?.[1];
  return candidate && VideoIdSchema.safeParse(candidate).success ? candidate : null;
}

async function discoverChannelVideos() {
  const raw: unknown = await youtubeDl(CHANNEL_URL, {
    dumpSingleJson: true,
    flatPlaylist: true,
    ignoreErrors: true,
    noWarnings: true,
    playlistEnd: 100,
    quiet: true,
    skipDownload: true,
  }, { timeout: 90_000 });
  const result = DiscoveryResultSchema.parse(raw);
  const now = new Date().toISOString();
  const discovered = (result.entries ?? []).flatMap((rawEntry) => {
    const parsedEntry = DiscoveryEntrySchema.safeParse(rawEntry);
    if (!parsedEntry.success) return [];
    const videoId = videoIdFromEntry(parsedEntry.data);
    const title = parsedEntry.data.title?.trim();
    if (!videoId || !title) return [];
    return [DirectorVideoSchema.parse({
      videoId,
      title: title.slice(0, 200),
      youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`,
      status: "discovered",
      updatedAt: now,
      segments: [],
    })];
  });
  const catalog = await readPrivateCatalog();
  const existing = new Map(catalog.videos.map((video) => [video.videoId, video]));
  const merged = discovered.map((video) => {
    const prior = existing.get(video.videoId);
    return prior
      ? DirectorVideoSchema.parse({ ...prior, title: video.title, youtubeUrl: video.youtubeUrl })
      : video;
  });
  const foundIds = new Set(merged.map((video) => video.videoId));
  const combined = [
    ...merged,
    ...catalog.videos.filter((video) => !foundIds.has(video.videoId)),
  ].slice(0, 500);
  const saved = await savePrivateCatalog(combined);
  return { catalog: saved, discoveredCount: discovered.length };
}

async function transcribeYoutubeVideo(videoId: string): Promise<z.infer<typeof LibraryVideoSegmentSchema>[]> {
  if (!env.DEEPGRAM_API_KEY) throw new Error("DEEPGRAM_API_KEY is not configured on Nexus Director.");
  const audioUrl = await youtubeDl(`https://www.youtube.com/watch?v=${videoId}`, {
    format: "bestaudio/best",
    getUrl: true,
    noPlaylist: true,
    noWarnings: true,
    quiet: true,
    socketTimeout: 20,
  }, { timeout: 45_000 });
  if (typeof audioUrl !== "string") throw new Error("YouTube did not return an audio stream.");
  const directUrl = audioUrl.trim().split(/\r?\n/)[0];
  if (!directUrl) throw new Error("YouTube did not return an audio stream.");
  const parsedUrl = new URL(directUrl);
  if (parsedUrl.protocol !== "https:" || !parsedUrl.hostname.endsWith(".googlevideo.com")) {
    throw new Error("YouTube returned an unsupported audio stream URL.");
  }

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
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url: directUrl }),
    signal: AbortSignal.timeout(150_000),
  });
  const raw: unknown = await response.json();
  const parsed = DeepgramResponseSchema.safeParse(raw);
  if (!response.ok) {
    throw new Error(parsed.success
      ? parsed.data.err_msg ?? `Deepgram returned HTTP ${response.status}.`
      : `Deepgram returned HTTP ${response.status}.`);
  }
  if (!parsed.success) throw new Error("Deepgram returned an invalid response.");
  const segments = LibraryVideoSegmentSchema.array().parse(
    (parsed.data.results?.utterances ?? []).flatMap((utterance) => {
      const text = utterance.transcript?.trim() ?? "";
      if (!text || utterance.start === undefined || utterance.end === undefined) return [];
      return [{ startSeconds: utterance.start, endSeconds: utterance.end, text }];
    }),
  );
  if (segments.length === 0) throw new Error("No timestamped speech was detected in the video.");
  return segments;
}

export async function GET() {
  if (!directorAuthIsConfigured()) {
    return NextResponse.json(
      { error: "Configure Director authentication before managing private video sources." },
      { status: 503 },
    );
  }
  try {
    return NextResponse.json(await readPrivateCatalog(), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not load Director video sources." },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  if (!directorAuthIsConfigured()) {
    return NextResponse.json(
      { error: "Configure Director authentication before managing private video sources." },
      { status: 503 },
    );
  }
  let action: z.infer<typeof ActionSchema>;
  try {
    action = ActionSchema.parse(await request.json() as unknown);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid video action." },
      { status: 400 },
    );
  }

  try {
    if (action.action === "discover") return NextResponse.json(await discoverChannelVideos());

    const catalog = await readPrivateCatalog();
    const video = catalog.videos.find((item) => item.videoId === action.videoId);
    if (!video) return NextResponse.json({ error: "Video not found in the Director catalog." }, { status: 404 });

    if (action.action === "process") {
      if (video.status === "published" && video.segments.length > 0) {
        return NextResponse.json({ video });
      }
      const processing = DirectorVideoSchema.parse({
        ...video,
        status: "processing",
        updatedAt: new Date().toISOString(),
        error: undefined,
      });
      const processingCatalog = await savePrivateCatalog(catalog.videos.map((item) =>
        item.videoId === video.videoId ? processing : item,
      ));
      try {
        const segments = await transcribeYoutubeVideo(video.videoId);
        const ready = DirectorVideoSchema.parse({
          ...processing,
          status: "ready",
          updatedAt: new Date().toISOString(),
          segments,
        });
        await writeJsonObject(`director/videos/${video.videoId}.json`, ready);
        const saved = await savePrivateCatalog(processingCatalog.videos.map((item) =>
          item.videoId === video.videoId ? ready : item,
        ));
        return NextResponse.json({ video: saved.videos.find((item) => item.videoId === video.videoId) });
      } catch (error) {
        const failed = DirectorVideoSchema.parse({
          ...processing,
          status: "failed",
          updatedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message.slice(0, 1000) : "Transcription failed.",
        });
        await savePrivateCatalog(processingCatalog.videos.map((item) =>
          item.videoId === video.videoId ? failed : item,
        ));
        throw error;
      }
    }

    if (action.action === "approve") {
      if (video.segments.length === 0) {
        return NextResponse.json({ error: "Transcribe this video before approving it for the library." }, { status: 409 });
      }
      const publishedRecord = LibraryVideoRecordSchema.parse({
        videoId: video.videoId,
        title: video.title,
        youtubeUrl: video.youtubeUrl,
        addedAt: new Date().toISOString(),
        segments: video.segments,
      });
      const publishedCatalog = await readPublishedCatalog();
      if (
        !publishedCatalog.videos.some((item) => item.videoId === video.videoId) &&
        publishedCatalog.videos.length >= 500
      ) {
        return NextResponse.json({ error: "The public video library has reached its 500-video limit." }, { status: 409 });
      }
      await writeJsonObject(`published/videos/${video.videoId}.json`, publishedRecord, true);
      const updatedPublicCatalog = LibraryVideoCatalogSchema.parse({
        updatedAt: new Date().toISOString(),
        videos: [{
          videoId: publishedRecord.videoId,
          title: publishedRecord.title,
          youtubeUrl: publishedRecord.youtubeUrl,
          addedAt: publishedRecord.addedAt,
        }, ...publishedCatalog.videos.filter((item) => item.videoId !== video.videoId)],
      });
      await writeJsonObject(PUBLISHED_CATALOG_KEY, updatedPublicCatalog, true);
      const approved = DirectorVideoSchema.parse({
        ...video,
        status: "published",
        updatedAt: new Date().toISOString(),
        error: undefined,
      });
      const updatedPrivateCatalog = await savePrivateCatalog(catalog.videos.map((item) =>
        item.videoId === video.videoId ? approved : item,
      ));
      return NextResponse.json({ catalog: updatedPrivateCatalog });
    }

    if (action.action === "unpublish") {
      const publishedCatalog = await readPublishedCatalog();
      const updatedPublicCatalog = LibraryVideoCatalogSchema.parse({
        updatedAt: new Date().toISOString(),
        videos: publishedCatalog.videos.filter((item) => item.videoId !== video.videoId),
      });
      await writeJsonObject(PUBLISHED_CATALOG_KEY, updatedPublicCatalog, true);
      await deleteObject(`published/videos/${video.videoId}.json`);
      const draft = DirectorVideoSchema.parse({
        ...video,
        status: "ready",
        updatedAt: new Date().toISOString(),
      });
      const updatedPrivateCatalog = await savePrivateCatalog(catalog.videos.map((item) =>
        item.videoId === video.videoId ? draft : item,
      ));
      return NextResponse.json({ catalog: updatedPrivateCatalog });
    }

    if (video.status === "published") {
      return NextResponse.json({ error: "Unpublish this video before deleting its Director record." }, { status: 409 });
    }
    await deleteObject(`director/videos/${video.videoId}.json`);
    const updatedCatalog = await savePrivateCatalog(catalog.videos.filter((item) => item.videoId !== video.videoId));
    return NextResponse.json({ catalog: updatedCatalog });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Video operation failed." },
      { status: 502 },
    );
  }
}
