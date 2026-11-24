import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ShortMusicFavoriteSchema } from "@/lib/schemas/short-media";
import { readShortMusicLibrary, saveShortMusicLibrary } from "@/lib/shorts-store";

export const runtime = "nodejs";

const ActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("save"),
    favorite: ShortMusicFavoriteSchema,
  }).strict(),
  z.object({
    action: z.literal("remove"),
    id: z.string().uuid(),
  }).strict(),
]);

function authConfigured(): boolean {
  return Boolean(process.env.AUTH_PASSWORD && process.env.AUTH_COOKIE_SECRET);
}

export async function GET() {
  if (!authConfigured()) {
    return NextResponse.json({ error: "Configure Director authentication before loading saved Shorts music." }, { status: 503 });
  }
  try {
    return NextResponse.json(await readShortMusicLibrary(), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not load saved Shorts music." },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  if (!authConfigured()) {
    return NextResponse.json({ error: "Configure Director authentication before saving Shorts music." }, { status: 503 });
  }
  let action: z.infer<typeof ActionSchema>;
  try {
    action = ActionSchema.parse(await request.json() as unknown);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid Shorts music library action." },
      { status: 400 },
    );
  }

  try {
    const library = await readShortMusicLibrary();
    if (action.action === "remove") {
      return NextResponse.json(await saveShortMusicLibrary(
        library.favorites.filter((favorite) => favorite.id !== action.id),
      ));
    }
    if (library.favorites.some((favorite) => favorite.audioUrl === action.favorite.audioUrl)) {
      return NextResponse.json(library);
    }
    if (library.favorites.length >= 100) {
      return NextResponse.json({ error: "The Shorts music library is full. Remove a saved sound before adding another." }, { status: 409 });
    }
    return NextResponse.json(await saveShortMusicLibrary([
      action.favorite,
      ...library.favorites,
    ]));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not update saved Shorts music." },
      { status: 500 },
    );
  }
}
