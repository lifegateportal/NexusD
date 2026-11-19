import { NextResponse } from "next/server";
import { z } from "zod";
import { listPrivateShortVersions, readPrivateShortVersion } from "@/lib/shorts-store";

export const runtime = "nodejs";

const SlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
const VersionIdSchema = z.string().uuid();

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  if (!SlugSchema.safeParse(slug).success) {
    return NextResponse.json({ error: "Invalid video short ID." }, { status: 400 });
  }
  if (!process.env.AUTH_PASSWORD || !process.env.AUTH_COOKIE_SECRET) {
    return NextResponse.json(
      { error: "Configure Director authentication before loading short history." },
      { status: 503 },
    );
  }

  try {
    const versionId = new URL(request.url).searchParams.get("version");
    if (versionId) {
      if (!VersionIdSchema.safeParse(versionId).success) {
        return NextResponse.json({ error: "Invalid version ID." }, { status: 400 });
      }
      const project = await readPrivateShortVersion(slug, versionId);
      return project
        ? NextResponse.json({ project }, { headers: { "Cache-Control": "private, no-store" } })
        : NextResponse.json({ error: "Saved short version not found." }, { status: 404 });
    }

    return NextResponse.json(await listPrivateShortVersions(slug), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not load saved short history." },
      { status: 500 },
    );
  }
}
