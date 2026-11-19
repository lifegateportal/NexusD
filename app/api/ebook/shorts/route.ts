import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  deletePrivateShort,
  listPrivateShorts,
  listPublicShorts,
  publishShort,
  readPrivateShort,
  savePrivateShort,
  unpublishShort,
} from "@/lib/shorts-store";
import { ShortProjectSchema, ShortSlugSchema } from "@/lib/schemas/video-short";

export const runtime = "nodejs";

const ActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save"), project: ShortProjectSchema }).strict(),
  z.object({ action: z.literal("publish"), project: ShortProjectSchema }).strict(),
  z.object({ action: z.literal("unpublish"), slug: ShortSlugSchema }).strict(),
  z.object({ action: z.literal("delete"), slug: ShortSlugSchema }).strict(),
]);

function authConfigured(): boolean {
  return Boolean(process.env.AUTH_PASSWORD && process.env.AUTH_COOKIE_SECRET);
}

export async function GET() {
  if (!authConfigured()) {
    return NextResponse.json({ error: "Configure Director authentication before managing video shorts." }, { status: 503 });
  }
  try {
    return NextResponse.json(await listPrivateShorts(), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not load private video shorts." },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  if (!authConfigured()) {
    return NextResponse.json({ error: "Configure Director authentication before managing video shorts." }, { status: 503 });
  }

  let action: z.infer<typeof ActionSchema>;
  try {
    action = ActionSchema.parse(await request.json() as unknown);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid video short action." },
      { status: 400 },
    );
  }

  try {
    if (action.action === "save") {
      const publicCatalog = await listPublicShorts();
      const status = publicCatalog.shorts.some((short) => short.slug === action.project.slug)
        ? "published"
        : "draft";
      const project = await savePrivateShort(action.project, status);
      return NextResponse.json({ project });
    }
    if (action.action === "publish") {
      const project = await publishShort({ ...action.project, status: "published" });
      return NextResponse.json({ project });
    }
    if (action.action === "unpublish") {
      await unpublishShort(action.slug);
      return NextResponse.json({ shorts: await listPrivateShorts() });
    }

    const publicCatalog = await listPublicShorts();
    if (publicCatalog.shorts.some((short) => short.slug === action.slug)) {
      return NextResponse.json({ error: "Unpublish this short before deleting its Director draft." }, { status: 409 });
    }
    const existing = await readPrivateShort(action.slug);
    if (!existing) return NextResponse.json({ error: "Video short not found." }, { status: 404 });
    await deletePrivateShort(action.slug);
    return NextResponse.json({ shorts: await listPrivateShorts() });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Video short operation failed." },
      { status: 500 },
    );
  }
}
