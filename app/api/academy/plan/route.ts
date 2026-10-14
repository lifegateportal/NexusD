import { generateObject } from "ai";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deepSeekChatModel } from "@/lib/ai-providers";
import { IngestResultSchema } from "@/lib/schemas/blueprint";
import {
  AcademyBuildBriefSchema,
  AcademyOutlineSchema,
} from "@/lib/schemas/academy-build";

export const runtime = "nodejs";
export const maxDuration = 90;

const PlanRequestSchema = z.object({
  blueprint: IngestResultSchema,
  sourceText: z.string().max(180_000).default(""),
  buildBrief: AcademyBuildBriefSchema,
}).strict();

function sampleSource(sourceText: string): string {
  const maxCharacters = 120_000;
  if (sourceText.length <= maxCharacters) return sourceText;
  const sampleSize = 12_000;
  const middleStart = Math.floor(sourceText.length / 2) - Math.floor(sampleSize / 2);
  return [
    sourceText.slice(0, sampleSize),
    sourceText.slice(Math.max(sampleSize, middleStart), Math.max(sampleSize, middleStart) + sampleSize),
    sourceText.slice(-sampleSize),
  ].join("\n\n[…]\n\n");
}

export async function POST(request: NextRequest) {
  let input: z.infer<typeof PlanRequestSchema>;
  try {
    input = PlanRequestSchema.parse(await request.json() as unknown);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid Academy planning request." },
      { status: 400 },
    );
  }

  try {
    const { object } = await generateObject({
      model: deepSeekChatModel,
      schema: AcademyOutlineSchema,
      schemaName: "AcademyOutline",
      schemaDescription: "A teachable Academy course outline grounded in the supplied source material.",
      mode: "json",
      maxTokens: 4_500,
      temperature: 0.2,
      system: `You are an instructional designer. Create an editable course outline from the source blueprint and material.

Follow the build brief exactly:
- Create exactly ${input.buildBrief.moduleCount} modules.
- Create exactly ${input.buildBrief.lessonsPerModule} lessons in every module.
- Use only these lesson types: ${input.buildBrief.allowedLessonTypes.join(", ")}.
- Target about ${input.buildBrief.targetLessonMinutes} minutes per lesson.
- Include quizzes only when requested: ${input.buildBrief.includeQuizzes ? "yes" : "no"}.
- Include exercises only when requested: ${input.buildBrief.includeExercises ? "yes" : "no"}.
- Difficulty: ${input.buildBrief.difficultyLevel}.
- Source fidelity: ${input.buildBrief.sourceFidelity}. Never invent source claims when fidelity is strict.

Make every module distinct, progressively useful, and grounded in the source. Each lesson must teach one focused idea and include a concise learner outcome. Return only the JSON object required by the schema.`,
      prompt: [
        "BUILD BRIEF:",
        JSON.stringify(input.buildBrief),
        "",
        "SOURCE BLUEPRINT:",
        JSON.stringify(input.blueprint),
        "",
        "SOURCE MATERIAL:",
        sampleSource(input.sourceText) || "(No transcript was provided; use the blueprint.)",
      ].join("\n"),
    });

    const outline = AcademyOutlineSchema.parse(object);
    const lessonCountsMatch = outline.modules.every(
      (module) => module.lessons.length === input.buildBrief.lessonsPerModule,
    );
    if (
      outline.modules.length !== input.buildBrief.moduleCount
      || !lessonCountsMatch
    ) {
      return NextResponse.json(
        { error: "The generated outline did not match the saved build brief. Please try again." },
        { status: 502 },
      );
    }

    return NextResponse.json({ outline });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Academy outline generation failed." },
      { status: 500 },
    );
  }
}
