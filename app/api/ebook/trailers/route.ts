import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  deleteTrailer,
  hasTrailerStorageConfiguration,
  listTrailers,
  publishTrailer,
  saveTrailer,
  unpublishTrailer,
} from "@/lib/trailer-store";
import {
  TrailerProjectSchema,
  TrailerPublishRequestSchema,
  TrailerSlugSchema,
} from "@/lib/schemas/trailer";

export const runtime = "nodejs";

const ActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save"), project: TrailerProjectSchema }).strict(),
  z.object({
    action: z.literal("publish"),
    ...TrailerPublishRequestSchema.shape,
  }).strict(),
  z.object({ action: z.literal("unpublish"), slug: TrailerSlugSchema }).strict(),
  z.object({ action: z.literal("delete"), slug: TrailerSlugSchema }).strict(),
]);

function authConfigured(): boolean {
  return Boolean(process.env.AUTH_PASSWORD && process.env.AUTH_COOKIE_SECRET);
}

export async function GET() {
  if (!authConfigured()) {
    return NextResponse.json({ error: "Configure Director authentication before managing trailers." }, { status: 503 });
  }
  if (!hasTrailerStorageConfiguration()) {
    return NextResponse.json({ error: "Configure Cloudflare R2 to save Trailer Studio projects." }, { status: 503 });
  }
  try {
    return NextResponse.json(await listTrailers(), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not load trailer projects." },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  if (!authConfigured()) {
    return NextResponse.json({ error: "Configure Director authentication before managing trailers." }, { status: 503 });
  }
  if (!hasTrailerStorageConfiguration()) {
    return NextResponse.json({ error: "Configure Cloudflare R2 to save Trailer Studio projects." }, { status: 503 });
  }

  let action: z.infer<typeof ActionSchema>;
  try {
    action = ActionSchema.parse(await request.json() as unknown);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid trailer project action." },
      { status: 400 },
    );
  }

  try {
    switch (action.action) {
      case "save":
        return NextResponse.json({ project: await saveTrailer(action.project) });
      case "publish":
        return NextResponse.json({ trailer: await publishTrailer({
          slug: action.slug,
          title: action.title,
          sourceType: action.sourceType,
          videoId: action.videoId,
          videoTitle: action.videoTitle,
          videoUrl: action.videoUrl,
          aspectRatio: action.aspectRatio,
          moments: action.moments,
          musicTracks: action.musicTracks,
          headline: action.headline,
          brandLine: action.brandLine,
          callToAction: action.callToAction,
        }) });
      case "unpublish":
        await unpublishTrailer(action.slug);
        return NextResponse.json(await listTrailers());
      case "delete":
        await deleteTrailer(action.slug);
        return NextResponse.json(await listTrailers());
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Trailer project operation failed." },
      { status: 500 },
    );
  }
}
