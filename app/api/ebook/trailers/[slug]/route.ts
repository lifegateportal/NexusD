import { NextResponse } from "next/server";
import { z } from "zod";
import {
  hasTrailerStorageConfiguration,
  readTrailer,
} from "@/lib/trailer-store";
import { TrailerSlugSchema } from "@/lib/schemas/trailer";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  if (!process.env.AUTH_PASSWORD || !process.env.AUTH_COOKIE_SECRET) {
    return NextResponse.json({ error: "Configure Director authentication before opening trailers." }, { status: 503 });
  }
  if (!hasTrailerStorageConfiguration()) {
    return NextResponse.json({ error: "Configure Cloudflare R2 to load Trailer Studio projects." }, { status: 503 });
  }

  const { slug } = await params;
  const parsedSlug = TrailerSlugSchema.safeParse(slug);
  if (!parsedSlug.success) {
    return NextResponse.json({ error: "Enter a valid trailer project slug." }, { status: 400 });
  }
  try {
    const project = await readTrailer(parsedSlug.data);
    if (!project) return NextResponse.json({ error: "Trailer project not found." }, { status: 404 });
    return NextResponse.json(project, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not load this trailer project." },
      { status: 500 },
    );
  }
}
