import { NextResponse } from "next/server";
import { readPublicShort } from "@/lib/shorts-store";
import { ShortSlugSchema } from "@/lib/schemas/video-short";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  if (!ShortSlugSchema.safeParse(slug).success) {
    return NextResponse.json({ error: "Invalid video short ID." }, { status: 400 });
  }
  try {
    const project = await readPublicShort(slug);
    return project
      ? NextResponse.json(project, { headers: { "Cache-Control": "public, max-age=60" } })
      : NextResponse.json({ error: "Video short not found." }, { status: 404 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not load this video short." },
      { status: 502 },
    );
  }
}
