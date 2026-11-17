import { NextResponse } from "next/server";
import { readPrivateShort } from "@/lib/shorts-store";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug)) {
    return NextResponse.json({ error: "Invalid video short ID." }, { status: 400 });
  }
  if (!process.env.AUTH_PASSWORD || !process.env.AUTH_COOKIE_SECRET) {
    return NextResponse.json({ error: "Configure Director authentication before managing video shorts." }, { status: 503 });
  }
  try {
    const project = await readPrivateShort(slug);
    return project
      ? NextResponse.json(project, { headers: { "Cache-Control": "private, no-store" } })
      : NextResponse.json({ error: "Video short not found." }, { status: 404 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not load video short." },
      { status: 500 },
    );
  }
}
