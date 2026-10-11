import { generateObject } from "ai";
import { NextRequest, NextResponse } from "next/server";
import { deepSeekChatModel } from "@/lib/ai-providers";
import {
  LogicTransformRequestSchema,
  LogicTransformResultSchema
} from "@/lib/schemas/blueprint";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const json = await request.json();
    const input = LogicTransformRequestSchema.parse(json);

    const { object } = await generateObject({
      model: deepSeekChatModel,
      schema: LogicTransformResultSchema,
      schemaName: "LogicTransformResult",
      schemaDescription: "Execution logic graph derived from the blueprint",
      mode: "json",
      maxTokens: 1_500,
      temperature: 0.1,
      system:
        "You are the Nexus Director structural reasoning engine. Return deterministic, architecture-first outputs that honor constraints and preserve referential integrity. Be concise — do not pad fields.",
      prompt: [
        "Transform the workspace blueprint into a strict execution logic graph.",
        "- Preserve all workflow dependencies.",
        "- Minimize branching complexity.",
        "- Identify risks and mitigation actions.",
        "- Return data that validates against the provided schema.",
        "",
        `Objective: ${input.objective}`,
        `Constraints: ${input.constraints.join(" | ") || "none"}`,
        `Blueprint JSON: ${JSON.stringify(input.blueprint)}`
      ].join("\n")
    });

    return NextResponse.json(object, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      {
        error: "Failed to generate logic structure",
        detail: message
      },
      { status: 400 }
    );
  }
}
