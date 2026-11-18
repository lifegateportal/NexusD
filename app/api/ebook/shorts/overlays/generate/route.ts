import { generateObject } from "ai";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deepSeekModel } from "@/lib/ai-providers";
import { ShortOverlayPresetResponseSchema } from "@/lib/schemas/video-short";

export const runtime = "nodejs";
export const maxDuration = 30;

const RequestSchema = z.object({
  brief: z.string().trim().min(1).max(1000),
  shortTitle: z.string().trim().max(120).default(""),
  instructions: z.string().trim().max(4000).default(""),
}).strict();

export async function POST(request: NextRequest) {
  if (!process.env.AUTH_PASSWORD || !process.env.AUTH_COOKIE_SECRET) {
    return NextResponse.json({ error: "Configure Director authentication before generating overlay presets." }, { status: 503 });
  }

  let input: z.infer<typeof RequestSchema>;
  try {
    input = RequestSchema.parse(await request.json() as unknown);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid overlay preset request." },
      { status: 400 },
    );
  }

  try {
    const result = await generateObject({
      model: deepSeekModel,
      schema: ShortOverlayPresetResponseSchema,
      maxTokens: 900,
      temperature: 0.6,
      system: "You are a senior motion graphics designer creating polished, mobile-first short-video overlay presets. Return 2–4 coordinated layers, using only the supplied text and frame styles. Keep text short, high-contrast, tasteful, and clear of the center of the video; use restrained accents, editorial typography, and professional visual hierarchy. Use frame layers sparingly. Never return CSS, HTML, scripts, URLs, image data, or unsupported style names. Text may use the short title or a concise phrase based on the creator's brief, but never invent factual claims.",
      prompt: `SHORT TITLE: ${input.shortTitle || "Untitled short"}\n\nCREATOR DESIGN BRIEF:\n${input.brief}\n\nREUSABLE CREATOR PREFERENCES:\n${input.instructions || "No additional preferences."}\n\nChoose layer styles only from: headline, lower-third, pill-label, outline-frame, corner-frame, neon-frame. Provide a name and a short description for this reusable preset. Use text layers for labels and title treatments; frame styles should be only decorative line work.`,
    });
    const preset = ShortOverlayPresetResponseSchema.safeParse(result.object);
    if (!preset.success) {
      return NextResponse.json({ error: "The overlay agent returned an invalid preset." }, { status: 502 });
    }
    return NextResponse.json(preset.data);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "The overlay agent could not generate a preset." },
      { status: 502 },
    );
  }
}
