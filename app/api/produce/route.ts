import { NextRequest } from "next/server";
import { generateObject } from "ai";
import { z } from "zod";
import { deepSeekChatModel } from "@/lib/ai-providers";
import { ProduceInputSchema, AcademyPackageSchema, AcademyShellSchema } from "@/lib/schemas/academy";
import { enforceAcademyMediaCapabilities, normalizeAcademyLearnerVoice } from "@/lib/academy-content";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = await req.json() as unknown;
  let input;
  try {
    input = ProduceInputSchema.parse(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return new Response(JSON.stringify({ error: message }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  const encoder = new TextEncoder();

  // SSE stream — keeps the connection alive with ping comments so reverse
  // proxies don't close the socket while DeepSeek generates the large object.
  const stream = new ReadableStream({
    async start(controller) {
      const ping = setInterval(() => {
        try { controller.enqueue(encoder.encode(": ping\n\n")); } catch { /* closed */ }
      }, 15_000);

      try {
        // Give DeepSeek the complete source whenever it fits the context budget.
        // Very large sources still receive representative coverage from all regions.
        const buildPhase1Source = (text: string | undefined): string => {
          if (!text) return "";
          const MAX_SOURCE_CONTEXT_CHARACTERS = 160_000;
          if (text.length <= MAX_SOURCE_CONTEXT_CHARACTERS) return text;
          const SAMPLE = 4_500; // chars per sample point (~1,200 tokens)
          const len = text.length;
          const beginning = text.slice(0, SAMPLE);
          const midStart  = Math.max(SAMPLE, Math.floor(len / 2) - Math.floor(SAMPLE / 2));
          const middle    = len > SAMPLE * 2 ? text.slice(midStart, midStart + SAMPLE) : "";
          const ending    = len > SAMPLE     ? text.slice(Math.max(0, len - SAMPLE))   : "";
          return [beginning, middle, ending].filter(Boolean).join("\n\n[…]\n\n");
        };
        const phase1Source = buildPhase1Source(input.rawTranscript);
        const hasVideoSource = input.assets.some((asset) => asset.type.toLowerCase() === "video");
        const lessonTypeInstruction = hasVideoSource
          ? "Use video only when it genuinely improves the lesson; reading, quiz, and exercise are also available."
          : "This course has no video source. Use only reading, quiz, or exercise lessons. Never create a video lesson or imply that a video exists.";
        const phase1SourceSection = phase1Source
          ? `\n\nSOURCE MATERIAL:\n${phase1Source}`
          : "";

        const deliverySection = input.deliveryInstructions
          ? `\n\nDELIVERY INSTRUCTIONS:\n${input.deliveryInstructions}`
          : "";

        const basePrompt = JSON.stringify({
          title: input.title,
          summary: input.summary,
          assets: input.assets,
          workflow: input.workflow,
          executionPlan: input.executionPlan,
          entities: input.entities,
          visualDirection: input.visualDirection,
        });

        // ── Scale: calibrate module/theme count to source length ─────────────
        // Spoken-word transcripts run ~800 chars/min with Deepgram formatting.
        // Text files scale similarly by content density.
        const transcriptChars = (input.rawTranscript ?? "").length;
        const estMinutes      = Math.max(1, Math.round(transcriptChars / 800));
        const scale = estMinutes < 5
          ? { minThemes: 1, maxThemes: 2, minMods: 1, maxMods: 1, maxIdx: 1 }
          : estMinutes < 15
          ? { minThemes: 2, maxThemes: 2, minMods: 2, maxMods: 2, maxIdx: 1 }
          : estMinutes < 40
          ? { minThemes: 3, maxThemes: 3, minMods: 3, maxMods: 3, maxIdx: 2 }
          : { minThemes: 3, maxThemes: 4, minMods: 3, maxMods: 4, maxIdx: 3 };

        const themeCountLabel = scale.minThemes === scale.maxThemes
          ? `exactly ${scale.minThemes}`
          : `${scale.minThemes}\u2013${scale.maxThemes}`;
        const modCountLabel = scale.minMods === scale.maxMods
          ? `exactly ${scale.minMods}`
          : `${scale.minMods}\u2013${scale.maxMods}`;

        // ── Phase 0: Content map ────────────────────────────────────────
        // Force DeepSeek to READ and MAP the source's distinct themes BEFORE
        // designing the curriculum. Each theme gets direct source passages so
        // every module is anchored to real, non-overlapping content.
        const ThemeEntrySchema = z.object({
          index:        z.number().int().min(0).max(scale.maxIdx),
          title:        z.string(),
          summary:      z.string(),
          keyPassages:  z.array(z.string()).min(1).max(3),
          sourceRegion: z.enum(["beginning", "early-middle", "late-middle", "end"]),
        });
        const ContentMapSchema = z.object({
          themes: z.array(ThemeEntrySchema).min(scale.minThemes).max(scale.maxThemes),
        });
        type ContentMap = z.infer<typeof ContentMapSchema>;

        const phase0Source = phase1Source || input.rawTranscript?.slice(0, 12_000) || "";
        let contentMap: ContentMap = { themes: [] };
        if (phase0Source) {
          const { object: map } = await generateObject({
            model: deepSeekChatModel,
            schema: ContentMapSchema,
            schemaName: "ContentMap",
            schemaDescription: "Distinct major themes found in the source material",
            mode: "json",
            maxTokens: 1_200,
            temperature: 0.1,
            system: `You are a source analyst. Read the material and identify ${themeCountLabel} useful major theme${scale.maxThemes === 1 ? "" : "s"} or sections. Cover the full arc of the document and use your editorial judgment to choose boundaries that will make the strongest academy.

For each theme:
- index: 0-based (0 = first theme in the source)
- title: 4–7 words, using the source's language where it helps
- summary: a concise account of what the source says about this theme
- keyPassages: 1–3 short verbatim or near-verbatim quotes taken directly from the source for this theme
- sourceRegion: where this theme appears in the document: "beginning" | "early-middle" | "late-middle" | "end"

Use the source as the foundation, but make sensible connections and framing choices for learners. Do not present unsupported facts as if they came from the source.`,
            prompt: `SOURCE MATERIAL:\n${phase0Source}`,
          });
          contentMap = map;
        }

        // Build a content map string for Phase 1 injection
        const contentMapSection = contentMap.themes.length > 0
          ? `\n\nCONTENT MAP — your curriculum MUST map exactly to these themes (one theme per module):\n${contentMap.themes.map((t) =>
              `MODULE ${t.index + 1}: "${t.title}"\n  What the source says: ${t.summary}\n  Source passages: ${t.keyPassages.map(p => `"${p}"`).join(" | ")}`
            ).join("\n\n")}`
          : "";

        // Dynamic token allocation: scale based on source length (3K-12K range)
        function calculateMaxTokens(sourceLength: number, complexity: number): number {
          const score = sourceLength / 1000 + complexity * 0.5;
          if (score < 3) return 3000;    // Small source
          if (score < 8) return 6000;    // Medium source
          if (score < 15) return 10000;  // Large source
          return 12000;                  // Very large source (book-length)
        }

        // ── Phase 1: Academy shell ──────────────────────────────────────────────
        // Generates all metadata, landing page, pricing, SEO, and module outlines
        // with lightweight lesson stubs only.
        const shellMaxTokens = calculateMaxTokens((input.rawTranscript ?? "").length, contentMap.themes.length);
        
        const { object: generatedShell } = await generateObject({
          model: deepSeekChatModel,
          schema: AcademyShellSchema,
          schemaName: "AcademyShell",
          schemaDescription: "Academy structure with landing page, pricing, SEO, and lesson outlines — no lesson content",
          mode: "json",
          maxTokens: shellMaxTokens,
          temperature: 0.3,
          system: `You are DeepSeek Chat v3, an expert educational content architect. Transform the source material into an online academy structure with strong editorial judgment and a clear learner experience.

OUTPUT ALL ACADEMY FIELDS. Keep the output focused enough to validate reliably.

FOR THE CURRICULUM: produce ${modCountLabel} module${scale.maxMods === 1 ? "" : "s"} within the schema limits. Give each module 2–3 useful lesson outlines. Lesson outline = title + type + durationMinutes only.
DO NOT write notes, quiz, keyTakeaways, or actionItems in this phase.
${lessonTypeInstruction}

Use the content map as useful research, not as a rigid script. Let the source, the delivery preferences, and your judgment determine the best curriculum flow. Avoid needless repetition, but allow concepts to connect across modules when that improves teaching.

LEARNER VOICE: Write directly to the learner using "you" and clear instructional language. Do not report on the source or narrate what a speaker, transcript, source, or material said.

FIELD GUIDE:
- academyName: Market-ready title from the core subject matter
- tagline: One punchy line — the student transformation
- targetAudience: One precise sentence
- difficultyLevel: "beginner" | "intermediate" | "advanced"
- totalEstimatedHours: Sum of lesson durations ÷ 60, rounded to 1dp
- certificateTitle: e.g. "Certificate in [Topic]"
- themeVariant: midnight (tech) | amber (business/faith) | emerald (health/nature) | rose (personal dev) | violet (design/code) | solar (beginner/broad)
- layoutVariant: "centered" | "split" | "minimal"

LANDING PAGE: headline (max 10 words), subheadline (1 sentence), problemStatement (2 sentences), features (4 bullets — specific outcomes only), cta (button text)

PRICING — exactly 3 tiers:
1. Free — priceUsd: 0, period: "once", 2 bullets
2. Pro — priceUsd: 47–97, period: "monthly", 4 bullets
3. Lifetime — priceUsd: 197–497, period: "once", 5 bullets

CURRICULUM: moduleTitle, moduleDescription (1–2 sentences), lessonOutlines (max 3 stubs)

SEO: title (50–60 chars), description (140–155 chars), keywords (6–8)
onboardingSteps: 3–4 steps

EDITORIAL JUDGMENT:
- Make the academy coherent, engaging, and useful rather than mechanically mirroring the source.
- Use the delivery preferences as first-class direction for voice, audience, emphasis, and presentation.
- Add reasonable framing and learner-facing language when it improves the result, but do not invent specific source claims, quotations, statistics, or attributions.`,
          prompt: basePrompt + contentMapSection + phase1SourceSection + deliverySection,
        });
        const shell = {
          ...generatedShell,
          curriculum: generatedShell.curriculum.map((module) => ({
            ...module,
            lessonOutlines: module.lessonOutlines.map((lesson) => (
              !hasVideoSource && lesson.type === "video"
                ? { ...lesson, type: "reading" as const }
                : lesson
            )),
          })),
        };

        // ── Phase 2: one generateObject call per module ───────────────────────
        // Splitting by module keeps each call well under DeepSeek's 8K output
        // limit. A single all-modules call would exceed it for any course with
        // rich notes, causing truncated JSON and a parse failure.
        const SingleModuleContentSchema = z.object({
          moduleIndex:        z.number().int().min(0),
          learningObjectives: z.array(z.string()).min(1).max(5),
          keyTerms: z.array(z.object({
            term:       z.string(),
            definition: z.string(),
          })).min(1).max(6),
          lessons: z.array(z.object({
            lessonIndex:  z.number().int().min(0),
            description:  z.string(),
            notes:        z.string(),
            keyTakeaways: z.array(z.string()).min(1).max(7),
            actionItems:  z.array(z.string()).min(1).max(4),
            quiz: z.array(z.object({
              q:       z.string(),
              options: z.array(z.string()).length(4),
              correct: z.number().int().min(0).max(3),
            })).min(3).max(3),
          })),
        });

        // Scale notes length to available source material. Short videos don't
        // have enough unique content to fill 500-word lessons without repetition.
        const notesWordCount = estMinutes < 5
          ? "150–200 words"
          : estMinutes < 15
          ? "200–300 words"
          : "350–500 words";

        const phase2System = `You are DeepSeek Chat v3, an expert educational content writer focused on a single module.

PER MODULE output:
- learningObjectives: useful outcomes for the learner
- keyTerms: the most useful terms for this module

PER LESSON output:
- description: state the specific learning outcome for this lesson
- notes: aim for ${notesWordCount}, adapting to the depth of the source rather than padding. Use readable prose and markdown where it helps.
- keyTakeaways: the clearest insights from this lesson
- actionItems: practical next steps that fit the lesson
- quiz: useful questions with four options and one correct index

Use the source, the module outline, and the delivery preferences as direction. Make the teaching coherent and engaging, connect ideas when helpful, and use your judgment about emphasis and explanation. Do not invent specific source claims, quotations, statistics, or attributions.`;
        const learnerVoiceRule = `Write directly to the learner. Use "you" and actionable teaching language. Never use reporting phrases such as "the speaker said", "the transcript explains", "the source states", or "the material teaches".`;

        const allModuleContents: z.infer<typeof SingleModuleContentSchema>[] = [];

        for (const [mi, mod] of shell.curriculum.entries()) {
          const theme = contentMap.themes[mi] ?? contentMap.themes[contentMap.themes.length - 1];
          const modOutline = [
            `MODULE ${mi} "${mod.moduleTitle}": ${mod.moduleDescription}`,
            ...mod.lessonOutlines.map((l, li) => `  LESSON ${li}: "${l.title}" (${l.type}, ${l.durationMinutes}min)`),
          ].join("\n");
          const themePassage = theme
            ? `THEME PASSAGES:\nTheme \u201c${theme.title}\u201d (${theme.sourceRegion}): ${theme.summary}\n  Passages: ${theme.keyPassages.map(p => `\u201c${p}\u201d`).join(" | ")}`
            : "";

          const lessonCount = mod.lessonOutlines.length;
          const moduleMaxTokens = calculateMaxTokens((input.rawTranscript ?? "").length, lessonCount);
          
          const { object: modContent } = await generateObject({
            model: deepSeekChatModel,
            schema: SingleModuleContentSchema,
            schemaName: "ModuleContent",
            schemaDescription: "Full lesson content for one academy module",
            mode: "json",
            maxTokens: moduleMaxTokens,
            temperature: 0.2,
            system: phase2System,
            prompt: [
              `Write all content for this module (moduleIndex: ${mi}):`,
              modOutline,
              "",
              themePassage,
              "",
              phase1Source ? `SOURCE MATERIAL:\n${phase1Source}` : "",
              deliverySection,
              learnerVoiceRule,
            ].filter(Boolean).join("\n"),
          });
          allModuleContents.push(modContent);
        }

        // Merge Phase 2 content back onto the Phase 1 shell
        const fullCurriculum = shell.curriculum.map((mod, mi) => {
          const modContent = allModuleContents[mi]
            ?? allModuleContents[allModuleContents.length - 1];
          return {
            moduleTitle:        mod.moduleTitle,
            moduleDescription:  mod.moduleDescription,
            learningObjectives: modContent.learningObjectives,
            keyTerms:           modContent.keyTerms,
            lessons: mod.lessonOutlines.map((outline, li) => {
              const lc = modContent.lessons.find(l => l.lessonIndex === li)
                ?? modContent.lessons[li]
                ?? modContent.lessons[modContent.lessons.length - 1];
              return {
                title:           outline.title,
                type:            outline.type,
                durationMinutes: outline.durationMinutes,
                description:     lc.description,
                notes:           lc.notes.trim(),
                keyTakeaways:    lc.keyTakeaways,
                actionItems:     lc.actionItems,
                quiz:            lc.quiz,
              };
            }),
          };
        });

        // ── Phase 3: Merge and validate ────────────────────────────────────────
        const academy = normalizeAcademyLearnerVoice(enforceAcademyMediaCapabilities(AcademyPackageSchema.parse({
          ...shell,
          curriculum: fullCurriculum,
          sourceCapabilities: { hasVideo: hasVideoSource },
        }), hasVideoSource));

        clearInterval(ping);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(academy)}\n\n`));
      } catch (error) {
        clearInterval(ping);
        const message = error instanceof Error ? error.message : "Produce stage failed";
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: message })}\n\n`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no", // disable nginx buffering
    },
  });
}
