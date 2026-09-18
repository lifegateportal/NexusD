import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { z } from "zod";
import { getSermonOutlineModel, getSermonCommandModel, getSermonTemperature } from "@/lib/sermon-assistant-model-selector";

export const runtime = "nodejs";
export const maxDuration = 120;

const RequestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("outline"),
    rawTranscript: z.string().min(1).max(120000),
    sermonAssistantModel: z.enum(["deepseek", "gemini"]).default("deepseek"),
  }),
  z.object({
    action: z.literal("command"),
    rawTranscript: z.string().min(1).max(120000),
    organizedMarkdown: z.string().max(120000).optional().default(""),
    command: z.string().min(1).max(2000),
    sermonAssistantModel: z.enum(["deepseek", "gemini"]).default("deepseek"),
  }),
]);

function outlineSystemPrompt(): string {
  return [
    "You are Nexus Sermon Assistant.",
    "Transform spoken transcript into a clear, well-organized sermon manuscript outline in Markdown.",
    "The user wants organized notes they can preach from and manually edit later.",
    "Use this structure whenever source supports it:",
    "# Sermon Title",
    "## Central Theme",
    "## Key Scriptures",
    "### Scripture Reference",
    "> Full scripture text",
    "- Why it matters in the sermon",
    "## Opening",
    "## Main Movement 1",
    "## Main Movement 2",
    "## Main Movement 3",
    "## Supporting Notes",
    "## Invitation / Response",
    "## Closing Prayer",
    "Keep it faithful to the transcript.",
    "If the speaker directly quoted scripture or clearly alluded to a scripture, identify it and include the full verse text when you can do so with high confidence.",
    "If a hinted scripture is plausible but not certain, place it under Key Scriptures with a note saying it is a likely reference.",
    "Do not invent stories, sermon points, or references not grounded in the transcript.",
    "Use bullet points for subpoints, transitions, applications, and supporting notes.",
    "Use blockquotes for scripture quotations.",
    "Preserve the speaker's language where it is strong, but rewrite into a clean, readable structure.",
    "Output only final Markdown.",
  ].join("\n");
}

function commandSystemPrompt(): string {
  return [
    "You are Nexus Sermon Assistant.",
    "You receive: transcript, current outline, and a user command.",
    "Apply the command precisely and return the complete updated sermon outline in Markdown.",
    "Edit only the scope requested by the user.",
    "If the user asks for changes to one section, only change that section and keep all other sections intact.",
    "Do not delete, condense, or rewrite unrelated sections.",
    "Preserve existing headings and order unless the user explicitly asks to move/remove/restructure them.",
    "When unsure, prefer minimal diffs over broad rewrites.",
    "Keep the outline well organized and preachable.",
    "Retain or improve the Key Scriptures section with full verse text for clearly identified scriptures and likely-reference notes for hints/allusions.",
    "Preserve unaffected sections.",
    "Do not add fabricated details not inferable from source material.",
    "Output only final Markdown.",
  ].join("\n");
}

function countWords(text: string): number {
  const tokens = text.trim().match(/\S+/g);
  return tokens ? tokens.length : 0;
}

function countHeadings(text: string): number {
  const matches = text.match(/^#{1,6}\s+/gm);
  return matches ? matches.length : 0;
}

function isGlobalRewriteCommand(command: string): boolean {
  return /(rewrite\s+(the\s+)?(entire|whole|full)|rewrite\s+all|overhaul|replace\s+everything|summari[sz]e\s+(the\s+)?(entire|whole|full)|condense\s+(the\s+)?(entire|whole|full)|shorten\s+(the\s+)?(entire|whole|full)|trim\s+everything)/i.test(command);
}

function looksAggressivelyTrimmed(previous: string, next: string, command: string): boolean {
  if (isGlobalRewriteCommand(command)) return false;

  const prevWords = countWords(previous);
  const nextWords = countWords(next);
  if (prevWords < 120) return false;

  const wordRatio = nextWords / Math.max(1, prevWords);
  const prevHeadings = countHeadings(previous);
  const nextHeadings = countHeadings(next);
  const headingRatio = prevHeadings > 0 ? nextHeadings / prevHeadings : 1;

  return wordRatio < 0.7 || headingRatio < 0.6;
}

function isLowSignalMarkdown(markdown: string): boolean {
  const normalized = markdown.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
  if (!normalized) return true;

  const words = normalized.match(/\b[\p{L}\p{N}][\p{L}\p{N}'-]*\b/gu) ?? [];
  if (words.length < 8) return true;

  const lettersAndDigits = normalized.match(/[\p{L}\p{N}]/gu) ?? [];
  if (lettersAndDigits.length < 24) return true;

  return false;
}

async function generateMarkdownWithFallback(args: {
  action: "outline" | "command";
  prompt: string;
  system: string;
  maxTokens: number;
  preferredChoice: "deepseek" | "gemini";
}): Promise<string> {
  const alternateChoice = args.preferredChoice === "deepseek" ? "gemini" : "deepseek";

  const modelAttempts = args.action === "outline"
    ? [
        {
          model: getSermonOutlineModel(args.preferredChoice),
          temperature: getSermonTemperature(args.preferredChoice, "outline"),
        },
        {
          model: getSermonOutlineModel(alternateChoice),
          temperature: getSermonTemperature(alternateChoice, "outline"),
        },
      ]
    : [
        {
          model: getSermonCommandModel(args.preferredChoice),
          temperature: getSermonTemperature(args.preferredChoice, "command"),
        },
        {
          model: getSermonOutlineModel(args.preferredChoice),
          temperature: getSermonTemperature(args.preferredChoice, "command"),
        },
        {
          model: getSermonCommandModel(alternateChoice),
          temperature: getSermonTemperature(alternateChoice, "command"),
        },
      ];

  let lastError: unknown = null;

  for (const attempt of modelAttempts) {
    try {
      const { text } = await generateText({
        model: attempt.model,
        temperature: attempt.temperature,
        maxTokens: args.maxTokens,
        system: args.system,
        prompt: args.prompt,
      });

      const markdown = text.trim();
      if (isLowSignalMarkdown(markdown)) {
        lastError = new Error("Model returned low-signal output");
        continue;
      }

      return markdown;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Generation failed after fallback attempts");
}

export async function POST(req: NextRequest) {
  let parsed: z.infer<typeof RequestSchema>;
  try {
    parsed = RequestSchema.parse(await req.json() as unknown);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid request" },
      { status: 400 },
    );
  }

  // Dynamic token allocation: scale based on input size (optimized for actual usage)
  function calculateMaxTokens(inputLength: number): number {
    if (inputLength < 2000) return 2000;   // 10-15 min sermon
    if (inputLength < 5000) return 3500;   // 20-30 min sermon
    if (inputLength < 10000) return 5000;  // 40-60 min sermon
    return 8000;                           // 90-120 min sermon
  }

  try {
    if (parsed.action === "outline") {
      const transcriptLength = parsed.rawTranscript.length;
      const maxTokens = calculateMaxTokens(transcriptLength);
      const markdown = await generateMarkdownWithFallback({
        action: "outline",
        prompt: `RAW TRANSCRIPT:\n${parsed.rawTranscript}`,
        system: outlineSystemPrompt(),
        maxTokens,
        preferredChoice: parsed.sermonAssistantModel,
      });

      return NextResponse.json({ markdown });
    }

    const prompt = [
      `RAW TRANSCRIPT:\n${parsed.rawTranscript}`,
      `CURRENT OUTLINE:\n${parsed.organizedMarkdown}`,
      `COMMAND:\n${parsed.command}`,
    ].join("\n\n");

    const combinedLength = parsed.rawTranscript.length + parsed.organizedMarkdown.length;
    const maxTokens = calculateMaxTokens(combinedLength);
    const markdown = await generateMarkdownWithFallback({
      action: "command",
      prompt,
      system: commandSystemPrompt(),
      maxTokens,
      preferredChoice: parsed.sermonAssistantModel,
    });

    // OPTIMIZATION: Disabled automatic retry logic (was firing on ~100% of outlines)
    // Outlines are intentionally condensed; apparent trimming is expected behavior.
    // If user unhappy with length, they can request expansion via command.

    return NextResponse.json({ markdown });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Generation failed" },
      { status: 500 },
    );
  }
}