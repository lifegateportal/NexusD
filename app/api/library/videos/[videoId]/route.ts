import { NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import {
  LibraryVideoCatalogSchema,
  LibraryVideoRecordSchema,
} from "@/lib/schemas/library-video";

export const runtime = "nodejs";

const VideoIdSchema = z.string().regex(/^[A-Za-z0-9_-]{11}$/);

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ videoId: string }> },
) {
  const parsedVideoId = VideoIdSchema.safeParse((await params).videoId);
  if (!parsedVideoId.success) {
    return NextResponse.json({ error: "Invalid YouTube video ID." }, { status: 400 });
  }

  const baseUrl = env.R2_PUBLIC_URL?.replace(/\/$/, "");
  if (!baseUrl) {
    return NextResponse.json({ error: "The approved video library is not configured." }, { status: 503 });
  }

  try {
    const catalogResponse = await fetch(`${baseUrl}/published/videos/index.json`, {
      cache: "no-store",
    });
    if (catalogResponse.status === 404) {
      return NextResponse.json({ error: "This video is not approved in the Library." }, { status: 404 });
    }
    if (!catalogResponse.ok) {
      return NextResponse.json({ error: "Could not load the approved video catalog." }, { status: 502 });
    }

    const catalog = LibraryVideoCatalogSchema.safeParse(await catalogResponse.json() as unknown);
    if (!catalog.success) {
      return NextResponse.json({ error: "The approved video catalog is invalid." }, { status: 502 });
    }
    const videoId = parsedVideoId.data;
    if (!catalog.data.videos.some((video) => video.videoId === videoId)) {
      return NextResponse.json({ error: "This video is not approved in the Library." }, { status: 404 });
    }

    const recordResponse = await fetch(`${baseUrl}/published/videos/${videoId}.json`, {
      cache: "no-store",
    });
    if (recordResponse.status === 404) {
      return NextResponse.json({ error: "The approved transcript for this video was not found." }, { status: 404 });
    }
    if (!recordResponse.ok) {
      return NextResponse.json({ error: "Could not load the approved video transcript." }, { status: 502 });
    }

    const record = LibraryVideoRecordSchema.safeParse(await recordResponse.json() as unknown);
    if (!record.success || record.data.videoId !== videoId) {
      return NextResponse.json({ error: "The approved video transcript is invalid." }, { status: 502 });
    }

    return NextResponse.json(record.data, {
      headers: { "Cache-Control": "public, max-age=60" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not load the approved video transcript." },
      { status: 502 },
    );
  }
}
