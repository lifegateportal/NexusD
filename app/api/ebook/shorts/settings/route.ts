import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ShortAgentSettingsSchema } from "@/lib/schemas/video-short";
import { readShortAgentSettings, saveShortAgentSettings } from "@/lib/shorts-store";

export const runtime = "nodejs";

function authConfigured(): boolean {
  return Boolean(process.env.AUTH_PASSWORD && process.env.AUTH_COOKIE_SECRET);
}

export async function GET() {
  if (!authConfigured()) {
    return NextResponse.json({ error: "Configure Director authentication before managing Shorts settings." }, { status: 503 });
  }
  try {
    return NextResponse.json(await readShortAgentSettings(), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not load Shorts agent settings." },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest) {
  if (!authConfigured()) {
    return NextResponse.json({ error: "Configure Director authentication before managing Shorts settings." }, { status: 503 });
  }
  let settings: z.infer<typeof ShortAgentSettingsSchema>;
  try {
    settings = ShortAgentSettingsSchema.parse(await request.json() as unknown);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid Shorts agent settings." },
      { status: 400 },
    );
  }
  try {
    return NextResponse.json(await saveShortAgentSettings(settings));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not save Shorts agent settings." },
      { status: 500 },
    );
  }
}
