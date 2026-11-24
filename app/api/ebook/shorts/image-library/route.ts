import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import {
  ShortImageAssetSchema,
} from "@/lib/schemas/short-assets";
import {
  readShortImageLibrary,
  saveShortImageLibrary,
} from "@/lib/shorts-store";

export const runtime = "nodejs";

const SaveRequestSchema = z.object({
  action: z.literal("save"),
  fileName: z.string().trim().min(1).max(255),
  imageUrl: z.string().url(),
}).strict();

const RemoveRequestSchema = z.object({
  action: z.literal("remove"),
  id: z.string().uuid(),
}).strict();

function isShortAssetUrl(value: string): boolean {
  if (!env.R2_PUBLIC_URL) return false;
  try {
    const publicBase = new URL(env.R2_PUBLIC_URL);
    const asset = new URL(value);
    const publicPath = publicBase.pathname.replace(/\/$/, "");
    return asset.protocol === "https:"
      && asset.origin === publicBase.origin
      && asset.pathname.startsWith(`${publicPath}/published/shorts/assets/`)
      && !asset.search
      && !asset.hash;
  } catch {
    return false;
  }
}

function authConfigured(): boolean {
  return Boolean(process.env.AUTH_PASSWORD && process.env.AUTH_COOKIE_SECRET);
}

export async function GET() {
  if (!authConfigured()) {
    return NextResponse.json({ error: "Configure Director authentication before managing saved Shorts images." }, { status: 503 });
  }
  try {
    return NextResponse.json(await readShortImageLibrary(), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not load saved Shorts images." },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  if (!authConfigured()) {
    return NextResponse.json({ error: "Configure Director authentication before managing saved Shorts images." }, { status: 503 });
  }
  let input: z.infer<typeof SaveRequestSchema>;
  try {
    input = SaveRequestSchema.parse(await request.json() as unknown);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid saved-image request." },
      { status: 400 },
    );
  }
  if (!isShortAssetUrl(input.imageUrl)) {
    return NextResponse.json({ error: "Only images uploaded to the Shorts asset library can be saved." }, { status: 400 });
  }

  try {
    const library = await readShortImageLibrary();
    const existing = library.images.find((image) => image.imageUrl === input.imageUrl);
    if (existing) return NextResponse.json(library);
    if (library.images.length >= 200) {
      return NextResponse.json({ error: "The saved image library is full. Remove an image before saving another." }, { status: 400 });
    }
    const image = ShortImageAssetSchema.parse({
      id: crypto.randomUUID(),
      fileName: input.fileName,
      imageUrl: input.imageUrl,
    });
    return NextResponse.json(await saveShortImageLibrary([...library.images, image]));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not save this image to the library." },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  if (!authConfigured()) {
    return NextResponse.json({ error: "Configure Director authentication before managing saved Shorts images." }, { status: 503 });
  }
  let input: z.infer<typeof RemoveRequestSchema>;
  try {
    input = RemoveRequestSchema.parse(await request.json() as unknown);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid saved-image request." },
      { status: 400 },
    );
  }
  try {
    const library = await readShortImageLibrary();
    return NextResponse.json(await saveShortImageLibrary(
      library.images.filter((image) => image.id !== input.id),
    ));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not remove this image from the library." },
      { status: 500 },
    );
  }
}
