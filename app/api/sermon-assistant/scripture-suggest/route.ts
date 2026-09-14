import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { z } from "zod";
import { deepSeekModel } from "@/lib/ai-providers";
import { getSermonOutlineModel, getSermonTemperature } from "@/lib/sermon-assistant-model-selector";

export const runtime = "nodejs";
export const maxDuration = 30;

const RequestSchema = z.object({
  context: z.string().min(10).max(4000),
  existingRefs: z.array(z.string().max(64)).max(50).optional().default([]),
  sermonAssistantModel: z.enum(["deepseek", "gemini"]).default("deepseek"),
});

const SYSTEM_PROMPT = `You are a Bible reference assistant for a live sermon transcription tool.
Given a transcript snippet, identify any Bible scriptures being referenced — whether directly quoted, paraphrased, or clearly alluded to.

You MUST respond with ONLY a valid JSON object, no prose, no markdown fences, no explanation.
Shape: {"suggestions":[{"ref":"John 3:16","text":"For God so loved the world...","reason":"Speaker quoted this directly","confidence":0.95}]}

Rules:
- Include explicit references: "Genesis chapter one" → Genesis 1:1, "John three sixteen" → John 3:16, "Psalm 23" → Psalm 23:1
- Include clear allusions: "in the beginning was the Word" → John 1:1, "I am the way" → John 14:6, "all things work together" → Romans 8:28
- Include phrases: "word was God", "God created the heavens", "trust in the Lord with all your heart"
- Never duplicate a ref in existingRefs
- confidence: 1.0=direct quote, 0.7-0.9=paraphrase, 0.5-0.69=allusion
- text: actual verse text (ESV or KJV), concise
- Return {"suggestions":[]} if nothing specific found
- Output ONLY the JSON object`;

export async function POST(req: NextRequest) {
  let input: z.infer<typeof RequestSchema>;
  try {
    input = RequestSchema.parse(await req.json() as unknown);
  } catch {
    return NextResponse.json({ suggestions: [] }, { status: 400 });
  }

  try {
    const userMessage = [
      input.existingRefs.length > 0
        ? `Already found — skip these refs: ${input.existingRefs.join(", ")}`
        : "",
      `Sermon transcript:\n${input.context}`,
    ].filter(Boolean).join("\n\n");

    const { text } = await generateText({
      model: getSermonOutlineModel(input.sermonAssistantModel),
      system: SYSTEM_PROMPT,
      prompt: userMessage,
      maxTokens: 1000,
      temperature: getSermonTemperature(input.sermonAssistantModel, "scripture"),
    });

    const cleaned = text.trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    const data = JSON.parse(cleaned) as { suggestions?: unknown[] };
    const suggestions = Array.isArray(data.suggestions)
      ? data.suggestions.filter(
          (item): item is { ref: string; text: string; reason?: string; confidence?: number } =>
            typeof (item as Record<string, unknown>).ref === "string" &&
            typeof (item as Record<string, unknown>).text === "string",
        )
      : [];

    const filtered = suggestions.filter(
      (item) =>
        !input.existingRefs.some(
          (ref) => ref.toLowerCase() === item.ref.toLowerCase(),
        ),
    );

    return NextResponse.json({ suggestions: filtered });
  } catch {
    return NextResponse.json({ suggestions: [] });
  }
}
