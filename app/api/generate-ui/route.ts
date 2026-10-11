import { generateObject } from "ai";
import { NextRequest, NextResponse } from "next/server";
import { deepSeekChatModel } from "@/lib/ai-providers";
import { UiManifestInputSchema, UiManifestResultSchema } from "@/lib/schemas/ui-manifest";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const json = await request.json();
    const input = UiManifestInputSchema.parse(json);

    const { object } = await generateObject({
      model: deepSeekChatModel,
      schema: UiManifestResultSchema,
      temperature: 0.3,
      system:
        "You design refined and touch-first UI manifests for premium tablet interfaces.",
      prompt: [
        "Create a UI manifest for Nexus Director.",
        `Objective: ${input.objective}`,
        `Domain: ${input.domain}`,
        `Constraints: ${input.constraints.join(" | ") || "none"}`
      ].join("\n")
    });

    return NextResponse.json(object, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: "Failed to generate UI manifest", detail: message },
      { status: 400 }
    );
  }
}
