import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { makeR2Client } from "@/lib/r2-storage";
import {
  fetchYoutubeChannelVideos,
  getYoutubeVideoIdFromUrl,
  YoutubePageTokenSchema,
} from "@/lib/youtube-channel";
import {
  DirectorVideoCatalogSchema,
  DirectorVideoSchema,
  LibraryVideoCatalogSchema,
  LibraryVideoRecordSchema,
  LibraryVideoSegmentSchema,
} from "@/lib/schemas/library-video";

export const runtime = "nodejs";
export const maxDuration = 30;

const PRIVATE_CATALOG_KEY = "director/videos/index.json";
const PUBLISHED_CATALOG_KEY = "published/videos/index.json";
const VideoIdSchema = z.string().regex(/^[A-Za-z0-9_-]{11}$/);
const PlaylistNamesSchema = z.array(z.string().trim().min(1).max(60)).max(12);
const ActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("discover"), pageToken: YoutubePageTokenSchema }).strict(),
  z.object({
    action: z.literal("add"),
    url: z.string().url().max(2000),
    title: z.string().trim().max(200).optional(),
    transcript: z.string().max(1_000_000).optional(),
    playlists: PlaylistNamesSchema.optional(),
    sermonStartSeconds: z.number().finite().min(0).optional(),
    sermonEndSeconds: z.number().finite().min(0).optional(),
  }).strict(),
  z.object({
    action: z.literal("save-transcript"),
    videoId: VideoIdSchema,
    transcript: z.string().min(1).max(1_000_000),
  }).strict(),
  z.object({
    action: z.literal("save-details"),
    videoId: VideoIdSchema,
    playlists: PlaylistNamesSchema,
    sermonStartSeconds: z.number().finite().min(0).nullable(),
    sermonEndSeconds: z.number().finite().min(0).nullable(),
  }).strict(),
  z.object({ action: z.literal("approve"), videoId: VideoIdSchema }).strict(),
  z.object({ action: z.literal("unpublish"), videoId: VideoIdSchema }).strict(),
  z.object({ action: z.literal("delete"), videoId: VideoIdSchema }).strict(),
]);
class TranscriptInputError extends Error {}

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

function parseTranscript(transcript: string): z.infer<typeof LibraryVideoSegmentSchema>[] {
  const lines = transcript.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  const timestampPattern = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[,.](\d{1,3}))?$/;
  const toSeconds = (value: string): number | null => {
    const match = timestampPattern.exec(value);
    if (!match) return null;
    const hours = Number(match[1] ?? 0);
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);
    const milliseconds = Number((match[4] ?? "").padEnd(3, "0"));
    if (minutes > 59 || seconds > 59) return null;
    return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
  };
  const cues: Array<{ startSeconds: number; endSeconds?: number; text: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    const ranged = line.match(/^((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[,.]\d{1,3})?)\s*-->\s*((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[,.]\d{1,3})?)/);
    if (ranged) {
      const startSeconds = toSeconds(ranged[1]);
      const endSeconds = toSeconds(ranged[2]);
      const text: string[] = [];
      while (index + 1 < lines.length && lines[index + 1].trim() && !lines[index + 1].includes("-->")) {
        index += 1;
        text.push(lines[index].trim());
      }
      if (startSeconds !== null && endSeconds !== null && endSeconds > startSeconds && text.length > 0) {
        cues.push({ startSeconds, endSeconds, text: text.join(" ").replace(/<[^>]*>/g, "").trim() });
      }
      continue;
    }

    const single = line.match(/^((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[,.]\d{1,3})?)(?:\s+(.+))?$/);
    if (!single) continue;
    const startSeconds = toSeconds(single[1]);
    if (startSeconds === null) continue;
    const text = single[2] ? [single[2]] : [];
    while (index + 1 < lines.length && lines[index + 1].trim()) {
      const next = lines[index + 1].trim();
      if (next.includes("-->") || /^((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[,.]\d{1,3})?)(?:\s+.*)?$/.test(next)) break;
      index += 1;
      text.push(next);
    }
    const content = text.join(" ").replace(/<[^>]*>/g, "").trim();
    if (content) cues.push({ startSeconds, text: content });
  }

  const orderedCues = cues.sort((left, right) => left.startSeconds - right.startSeconds);
  const segments = orderedCues.map((cue, index) => {
    const nextStart = orderedCues[index + 1]?.startSeconds;
    const parsed = LibraryVideoSegmentSchema.safeParse({
      startSeconds: cue.startSeconds,
      endSeconds: cue.endSeconds ?? (nextStart && nextStart > cue.startSeconds ? nextStart : cue.startSeconds + 5),
      text: cue.text,
    });
    if (!parsed.success) {
      throw new TranscriptInputError(`A timestamped transcript segment is invalid: ${parsed.error.issues[0]?.message ?? "check the timestamp and text length."}`);
    }
    return parsed.data;
  });
  if (segments.length > 20000) {
    throw new TranscriptInputError("The transcript contains more than 20,000 timestamped segments.");
  }
  if (segments.length === 0) {
    throw new TranscriptInputError("No timestamped transcript lines found. Use lines like “0:00 Welcome” or SRT/VTT timestamp cues.");
  }
  return segments;
}

async function discoverChannelVideos(pageToken?: string) {
  const { channelTitle, videos: entries, nextPageToken } = await fetchYoutubeChannelVideos(pageToken);
  const now = new Date().toISOString();
  const discovered = entries.map((entry) => DirectorVideoSchema.parse({
      videoId: entry.videoId,
      title: entry.title,
      youtubeUrl: entry.youtubeUrl,
      status: "discovered",
      updatedAt: now,
      segments: [],
    }));
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
  ];
  if (combined.length > 10000) {
    throw new Error("The Director queue has reached its 10,000-video limit.");
  }
  const saved = await savePrivateCatalog(combined);
  return {
    catalog: saved,
    discoveredCount: discovered.length,
    channelTitle,
    ...(nextPageToken ? { nextPageToken } : {}),
  };
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
    if (action.action === "discover") return NextResponse.json(await discoverChannelVideos(action.pageToken));

    const catalog = await readPrivateCatalog();
    if (action.action === "add") {
      const videoId = getYoutubeVideoIdFromUrl(action.url);
      if (!videoId) {
        return NextResponse.json({ error: "Enter a valid YouTube video, Shorts, or youtu.be URL." }, { status: 400 });
      }
      if (catalog.videos.some((item) => item.videoId === videoId)) {
        return NextResponse.json({ error: "This video is already in the Director queue." }, { status: 409 });
      }
      if (catalog.videos.length >= 10000) {
        return NextResponse.json({ error: "The Director video queue has reached its 10,000-video limit." }, { status: 409 });
      }
      const segments = action.transcript?.trim() ? parseTranscript(action.transcript) : [];
      const video = DirectorVideoSchema.parse({
        videoId,
        title: action.title?.trim() || `YouTube video ${videoId}`,
        youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`,
        playlists: action.playlists ?? [],
        ...(action.sermonStartSeconds !== undefined ? { sermonStartSeconds: action.sermonStartSeconds } : {}),
        ...(action.sermonEndSeconds !== undefined ? { sermonEndSeconds: action.sermonEndSeconds } : {}),
        status: segments.length ? "ready" : "discovered",
        updatedAt: new Date().toISOString(),
        segments,
      });
      if (segments.length) await writeJsonObject(`director/videos/${videoId}.json`, video);
      const updatedCatalog = await savePrivateCatalog([video, ...catalog.videos]);
      return NextResponse.json({ catalog: updatedCatalog });
    }

    if (action.action === "save-details") {
      const video = catalog.videos.find((item) => item.videoId === action.videoId);
      if (!video) return NextResponse.json({ error: "Video not found in the Director catalog." }, { status: 404 });
      const updatedVideo = DirectorVideoSchema.parse({
        ...video,
        playlists: [...new Set(action.playlists.map((name) => name.trim()).filter(Boolean))],
        sermonStartSeconds: action.sermonStartSeconds ?? undefined,
        sermonEndSeconds: action.sermonEndSeconds ?? undefined,
        updatedAt: new Date().toISOString(),
      });
      if (video.status === "published") {
        const publishedRecord = LibraryVideoRecordSchema.parse(
          await readJsonObject(`published/videos/${video.videoId}.json`),
        );
        const updatedRecord = LibraryVideoRecordSchema.parse({
          ...publishedRecord,
          playlists: updatedVideo.playlists,
          sermonStartSeconds: updatedVideo.sermonStartSeconds,
          sermonEndSeconds: updatedVideo.sermonEndSeconds,
        });
        await writeJsonObject(`published/videos/${video.videoId}.json`, updatedRecord, true);
        const publishedCatalog = await readPublishedCatalog();
        if (!publishedCatalog.videos.some((item) => item.videoId === video.videoId)) {
          throw new Error("The published video is missing from the public catalog.");
        }
        const updatedPublicCatalog = LibraryVideoCatalogSchema.parse({
          updatedAt: new Date().toISOString(),
          videos: publishedCatalog.videos.map((item) => item.videoId === video.videoId
            ? {
              videoId: updatedRecord.videoId,
              title: updatedRecord.title,
              youtubeUrl: updatedRecord.youtubeUrl,
              addedAt: updatedRecord.addedAt,
              playlists: updatedRecord.playlists,
              ...(updatedRecord.sermonStartSeconds !== undefined
                ? { sermonStartSeconds: updatedRecord.sermonStartSeconds }
                : {}),
              ...(updatedRecord.sermonEndSeconds !== undefined
                ? { sermonEndSeconds: updatedRecord.sermonEndSeconds }
                : {}),
            }
            : item),
        });
        await writeJsonObject(PUBLISHED_CATALOG_KEY, updatedPublicCatalog, true);
      } else {
        const detailKey = `director/videos/${video.videoId}.json`;
        const privateRecord = await readJsonObject(detailKey);
        if (privateRecord) await writeJsonObject(detailKey, updatedVideo);
      }
      const updatedCatalog = await savePrivateCatalog(catalog.videos.map((item) =>
        item.videoId === video.videoId ? updatedVideo : item,
      ));
      return NextResponse.json({ catalog: updatedCatalog });
    }

    if (action.action === "save-transcript") {
      const video = catalog.videos.find((item) => item.videoId === action.videoId);
      if (!video) return NextResponse.json({ error: "Video not found in the Director catalog." }, { status: 404 });
      if (video.status === "published") {
        return NextResponse.json({ error: "Unpublish this video before replacing its transcript." }, { status: 409 });
      }
      const updatedVideo = DirectorVideoSchema.parse({
        ...video,
        status: "ready",
        updatedAt: new Date().toISOString(),
        segments: parseTranscript(action.transcript),
        error: undefined,
      });
      await writeJsonObject(`director/videos/${video.videoId}.json`, updatedVideo);
      const updatedCatalog = await savePrivateCatalog(catalog.videos.map((item) =>
        item.videoId === video.videoId ? updatedVideo : item,
      ));
      return NextResponse.json({ catalog: updatedCatalog });
    }

    const video = catalog.videos.find((item) => item.videoId === action.videoId);
    if (!video) return NextResponse.json({ error: "Video not found in the Director catalog." }, { status: 404 });

    if (action.action === "approve") {
      if (
        video.sermonStartSeconds === undefined
        || video.sermonEndSeconds === undefined
        || video.sermonEndSeconds <= video.sermonStartSeconds
      ) {
        return NextResponse.json(
          { error: "Set and save both sermon start and end times before publishing this video." },
          { status: 409 },
        );
      }
      if (video.segments.length === 0) {
        return NextResponse.json({ error: "Paste and save a timestamped transcript before approval." }, { status: 409 });
      }
      const publishedRecord = LibraryVideoRecordSchema.parse({
        videoId: video.videoId,
        title: video.title,
        youtubeUrl: video.youtubeUrl,
        addedAt: new Date().toISOString(),
        playlists: video.playlists,
        ...(video.sermonStartSeconds !== undefined ? { sermonStartSeconds: video.sermonStartSeconds } : {}),
        ...(video.sermonEndSeconds !== undefined ? { sermonEndSeconds: video.sermonEndSeconds } : {}),
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
          playlists: publishedRecord.playlists,
          ...(publishedRecord.sermonStartSeconds !== undefined
            ? { sermonStartSeconds: publishedRecord.sermonStartSeconds }
            : {}),
          ...(publishedRecord.sermonEndSeconds !== undefined
            ? { sermonEndSeconds: publishedRecord.sermonEndSeconds }
            : {}),
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
      const publishedRecord = await readJsonObject(`published/videos/${video.videoId}.json`);
      const transcript = publishedRecord
        ? LibraryVideoRecordSchema.parse(publishedRecord).segments
        : video.segments;
      const updatedPublicCatalog = LibraryVideoCatalogSchema.parse({
        updatedAt: new Date().toISOString(),
        videos: publishedCatalog.videos
          .filter((item) => item.videoId !== video.videoId),
      });
      await writeJsonObject(PUBLISHED_CATALOG_KEY, updatedPublicCatalog, true);
      await deleteObject(`published/videos/${video.videoId}.json`);
      const draft = DirectorVideoSchema.parse({
        ...video,
        status: "ready",
        updatedAt: new Date().toISOString(),
        segments: transcript,
      });
      await writeJsonObject(`director/videos/${video.videoId}.json`, draft);
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
    if (error instanceof TranscriptInputError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Video operation failed." },
      { status: 502 },
    );
  }
}
