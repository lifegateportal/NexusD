import { generateObject } from "ai";
import { NextRequest, NextResponse } from "next/server";
import { deepSeekModel } from "@/lib/ai-providers";
import { IngestInputSchema, IngestResultSchema } from "@/lib/schemas/blueprint";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const json = await request.json();
    const input = IngestInputSchema.parse(json);

    // Trim source — blueprint extraction only needs a representative sample.
    // Sending the full transcript wastes tokens and slows the response.
    const sourceSample = input.sourceText.length > 10_000
      ? input.sourceText.slice(0, 5_000) + "\n\n[…]\n\n" + input.sourceText.slice(-3_000)
      : input.sourceText;

    const { object } = await generateObject({
      model: deepSeekModel,
      schema: IngestResultSchema,
      schemaName: "IngestResult",
      schemaDescription: "Structured blueprint extracted from source content",
      mode: "json",
      maxTokens: 4_000,
      system:
        "You are the Nexus Director Analyst. Extract a concise structured blueprint from the source. Be brief — every field should be the shortest accurate value. Do not pad or invent.",
      prompt: [
        "Extract a structured blueprint from this source. Be concise.",
        "- workflow: 2–4 steps max, each with a clear label and intent.",
        "- assets: list only assets explicitly mentioned in the source.",
        "- riskFlags: 1–2 flags only if there are genuine gaps.",
        "- Return only data that validates against the schema.",
        `Locale: ${input.locale}`,
        `Source: ${sourceSample}`
      ].join("\n")
    });

    return NextResponse.json(object, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: "Failed to ingest source media context", detail: message },
      { status: 400 }
    );
  }
}
