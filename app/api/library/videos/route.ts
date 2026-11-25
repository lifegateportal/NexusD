import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { isSermonClip, LibraryVideoCatalogSchema } from "@/lib/schemas/library-video";

export const runtime = "nodejs";

export async function GET() {
  const emptyCatalog = { updatedAt: new Date().toISOString(), videos: [] };
  if (!env.R2_PUBLIC_URL) return NextResponse.json(emptyCatalog);

  try {
    const response = await fetch(
      `${env.R2_PUBLIC_URL.replace(/\/$/, "")}/published/videos/index.json`,
      { next: { revalidate: 60 } },
    );
    if (response.status === 404) return NextResponse.json(emptyCatalog);
    if (!response.ok) {
      return NextResponse.json({ error: "Could not load the video library." }, { status: 502 });
    }
    const parsed = LibraryVideoCatalogSchema.safeParse(await response.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "The published video catalog is invalid." }, { status: 502 });
    }
    return NextResponse.json({
      ...parsed.data,
      videos: parsed.data.videos.filter(isSermonClip),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not load the video library." },
      { status: 502 },
    );
  }
}
