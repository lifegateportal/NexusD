import { generateObject } from "ai";
import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { deepSeekChatModel } from "@/lib/ai-providers";
import { AcademyPackageSchema } from "@/lib/schemas/academy";
import type { AcademyPackage } from "@/lib/schemas/academy";
import { SiteConfigSchema } from "@/lib/schemas/site-config";
import type { SiteConfig } from "@/lib/schemas/site-config";
import { enforceAcademyMediaCapabilities, normalizeAcademyLearnerVoice } from "@/lib/academy-content";
import { AcademyBuildBriefSchema, AcademyOutlineSchema } from "@/lib/schemas/academy-build";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 120;

const RequestSchema = z.object({
  academy:     AcademyPackageSchema,
  buildBrief:  AcademyBuildBriefSchema.optional(),
  coursePlan:  AcademyOutlineSchema.nullable().optional(),
  instruction: z.string().min(1).max(4000),
  siteConfig:  SiteConfigSchema.optional(),
  dryRun:       z.boolean().optional(),
  academyVersion: z.string().optional(),
  history: z.array(z.object({
    role:    z.enum(["user", "assistant"]),
    content: z.string().max(8000),
  })).max(20).optional(),
});

// ── Patch schemas — AI returns ONLY changed fields, never the full academy. ──
// This keeps output well under DeepSeek's 8K token limit regardless of academy size.

const LessonPatchSchema = z.object({
  lessonIndex:    z.number().int().min(0),
  operation:      z.enum(["update", "delete"]).default("update").optional(), // Explicit delete op
  title:          z.string().optional(),
  type:           z.enum(["video", "reading", "quiz", "exercise"]).optional(),
  durationMinutes:z.number().optional(),
  description:    z.string().optional(),
  notes:          z.string().optional(),
  keyTakeaways:   z.array(z.string()).optional(),
  actionItems:    z.array(z.string()).optional(),
  quiz: z.array(z.object({
    q:       z.string(),
    options: z.array(z.string()),
    correct: z.number().int().min(0).max(3),
  })).optional(),
});

const ModulePatchSchema = z.object({
  moduleIndex:       z.number().int().min(0),
  operation:         z.enum(["update", "delete", "insert"]).default("update").optional(), // Explicit ops
  insertAfterIndex:  z.number().int().min(-1).optional(), // For insert: -1 = beginning
  moduleTitle:       z.string().optional(),
  moduleDescription: z.string().optional(),
  learningObjectives:z.array(z.string()).optional(),
  keyTerms: z.array(z.object({ term: z.string(), definition: z.string() })).optional(),
  lessons: z.array(z.any()).optional(), // Full lessons array for new modules
  lessonPatches: z.array(LessonPatchSchema).optional(),
});

const AcademyPatchSchema = z.object({
  academyName:         z.string().optional(),
  tagline:             z.string().optional(),
  targetAudience:      z.string().optional(),
  difficultyLevel:     z.enum(["beginner", "intermediate", "advanced"]).optional(),
  totalEstimatedHours: z.number().optional(),
  certificateTitle:    z.string().optional(),
  themeVariant:  z.enum(["midnight", "amber", "emerald", "rose", "violet", "solar"]).optional(),
  layoutVariant: z.enum(["centered", "split", "minimal"]).optional(),
  landingPage: z.object({
    headline:         z.string().optional(),
    subheadline:      z.string().optional(),
    problemStatement: z.string().optional(),
    features: z.array(z.object({ title: z.string(), description: z.string() })).optional(),
    cta: z.string().optional(),
  }).optional(),
  pricing: z.array(z.object({
    name:     z.string(),
    priceUsd: z.number(),
    period:   z.enum(["once", "monthly", "yearly"]),
    features: z.array(z.string()),
  })).optional(),
  seoMeta: z.object({
    title:       z.string().optional(),
    description: z.string().optional(),
    keywords:    z.array(z.string()).optional(),
  }).optional(),
  onboardingSteps:  z.array(z.string()).optional(),
  moduleOrder: z.array(z.number().int().min(0)).optional(),
  curriculumPatches:z.array(ModulePatchSchema).optional(),
});

const PatchResponseSchema = z.object({
  academyPatch:        AcademyPatchSchema.optional(),
  siteConfigPatch:     SiteConfigSchema.partial().optional(),
  confidence:          z.enum(["high", "medium", "low"]).default("high"),
  clarificationNeeded: z.string().optional(),
  summary:             z.string(),
});

// ── Server-side merge helpers ────────────────────────────────────────────────

function applyAcademyPatch(
  academy: AcademyPackage,
  patch: z.infer<typeof AcademyPatchSchema>,
): AcademyPackage {
  const { curriculumPatches, moduleOrder, landingPage, seoMeta, pricing, onboardingSteps, ...topLevel } = patch;
  const updated: AcademyPackage = { ...academy, ...topLevel };

  if (landingPage)     updated.landingPage    = { ...academy.landingPage,    ...landingPage };
  // SAFEGUARD: Only replace arrays if they're non-empty or explicitly null
  if (pricing !== undefined) {
    if (pricing === null) updated.pricing = []; // explicit clear
    else if (pricing.length > 0) updated.pricing = pricing;
    // else: empty array in patch = ignored (prevents accidental wipes)
  }
  if (onboardingSteps !== undefined) {
    if (onboardingSteps === null) updated.onboardingSteps = [];
    else if (onboardingSteps.length > 0) updated.onboardingSteps = onboardingSteps;
  }
  if (seoMeta)         updated.seoMeta        = { ...academy.seoMeta, ...seoMeta };

  if (curriculumPatches?.length) {
    let curriculum = academy.curriculum.map((m) => ({ ...m, lessons: m.lessons.map((l) => ({ ...l })) }));
    
    // Sort patches: deletes last, inserts first, updates middle
    const deletes = curriculumPatches.filter((p) => p.operation === "delete");
    const inserts = curriculumPatches.filter((p) => p.operation === "insert");
    const updates = curriculumPatches.filter((p) => !p.operation || p.operation === "update");

    // 1. Apply inserts
    for (const mp of inserts) {
      const { insertAfterIndex = -1, lessons: newLessons, ...modFields } = mp;
      if (!newLessons || newLessons.length === 0) continue;
      const newModule = { ...modFields, lessons: newLessons } as typeof curriculum[0];
      if (insertAfterIndex === -1) curriculum.unshift(newModule);
      else curriculum.splice(insertAfterIndex + 1, 0, newModule);
    }

    // 2. Apply updates
    for (const mp of updates) {
      const { moduleIndex, lessonPatches, operation, insertAfterIndex, lessons: _, ...modFields } = mp;
      if (moduleIndex < 0 || moduleIndex >= curriculum.length) continue;
      Object.assign(curriculum[moduleIndex], modFields);
      
      if (lessonPatches) {
        let lessons = curriculum[moduleIndex].lessons;
        const lessonDeletes = lessonPatches.filter((lp) => lp.operation === "delete");
        const lessonUpdates = lessonPatches.filter((lp) => !lp.operation || lp.operation === "update");
        
        // Apply lesson updates
        for (const lp of lessonUpdates) {
          const { lessonIndex, operation: _, ...lessonFields } = lp;
          if (lessonIndex < 0 || lessonIndex >= lessons.length) continue;
          Object.assign(lessons[lessonIndex], lessonFields);
        }
        
        // Apply lesson deletes (reverse order to maintain indices)
        for (const lp of lessonDeletes.sort((a, b) => b.lessonIndex - a.lessonIndex)) {
          if (lp.lessonIndex >= 0 && lp.lessonIndex < lessons.length) {
            lessons.splice(lp.lessonIndex, 1);
          }
        }
        
        curriculum[moduleIndex].lessons = lessons;
      }
    }

    // 3. Apply module deletes (reverse order to maintain indices)
    for (const mp of deletes.sort((a, b) => b.moduleIndex - a.moduleIndex)) {
      if (mp.moduleIndex >= 0 && mp.moduleIndex < curriculum.length) {
        curriculum.splice(mp.moduleIndex, 1);
      }
    }

    updated.curriculum = curriculum;
  }

  if (moduleOrder) {
    const currentCurriculum = updated.curriculum;
    const isValidOrder = moduleOrder.length === currentCurriculum.length
      && new Set(moduleOrder).size === currentCurriculum.length
      && moduleOrder.every((index) => index >= 0 && index < currentCurriculum.length);
    if (isValidOrder) {
      updated.curriculum = moduleOrder.map((index) => currentCurriculum[index]);
    }
  }

  const parsed = AcademyPackageSchema.parse(updated);
  const hasVideoSource = parsed.sourceCapabilities.hasVideo
    || parsed.curriculum.some((module) => module.lessons.some((lesson) => lesson.type === "video"));
  return normalizeAcademyLearnerVoice(enforceAcademyMediaCapabilities(parsed, hasVideoSource));
}

function applySiteConfigPatch(
  base: SiteConfig,
  patch: Partial<SiteConfig>,
): SiteConfig {
  const merged = { ...base, ...patch };
  return SiteConfigSchema.parse(merged);
}

export async function POST(req: NextRequest) {
  const encoder = new TextEncoder();

  let parsedInput: z.infer<typeof RequestSchema> | undefined;
  try {
    const body = await req.json() as unknown;
    parsedInput = RequestSchema.parse(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request";
    return new Response(JSON.stringify({ error: message }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  const { academy, buildBrief, coursePlan, instruction, siteConfig } = parsedInput;
  const dryRun = parsedInput.dryRun ?? false;

  // ── Optimistic locking ───────────────────────────────────────────────
  function computeAcademyVersion(a: typeof academy): string {
    return createHash("sha256")
      .update(JSON.stringify({ academyName: a.academyName, curriculum: a.curriculum }))
      .digest("hex")
      .slice(0, 12);
  }
  const currentVersion = computeAcademyVersion(academy);
  if (parsedInput.academyVersion && parsedInput.academyVersion !== currentVersion) {
    return new Response(
      JSON.stringify({ error: "Conflict: the academy has been modified since you last loaded it. Please reload before editing.", code: "VERSION_CONFLICT" }),
      { status: 409, headers: { "Content-Type": "application/json" } }
    );
  } 
  const history = parsedInput.history ?? [];

  // closing the connection while DeepSeek is generating the response.
  const stream = new ReadableStream({
    async start(controller) {
      const ping = setInterval(() => {
        try { controller.enqueue(encoder.encode(": ping\n\n")); } catch { /* closed */ }
      }, 15_000);

      try {

    // Give the editor the complete current academy so it can make informed,
    // coherent decisions instead of editing against truncated lesson stubs.
    const academyContext = academy;

    // ── Conversation history block ────────────────────────────────────────
    const historyBlock = history.length > 0
      ? `\n\nCONVERSATION HISTORY (oldest first — use this for follow-up instructions):\n${history.map((m) => `${m.role === "user" ? "USER" : "DIRECTOR"}: ${m.content}`).join("\n")}`
      : "";

    const { object } = await generateObject({
      model: deepSeekChatModel,
      schema: PatchResponseSchema,
      schemaName: "AcademyPatch",
      schemaDescription: "Patch object describing only the fields that need to change in the academy and/or site config.",
      mode: "json",
      maxTokens: 6000,
      temperature: 0.3,
      system: `Output only a raw JSON object matching the requested patch schema. No code fences or commentary.

You are Nexus Director AI, an expert academy editor with control over the academy content, visual presentation, and site configuration. Treat the user's instruction as the creative authority. Use the complete academy context and your own editorial judgment to make the requested change, including broad or structural changes when the user asks for them.

Return only fields that need to change so the server can merge your patch safely. Preserve unrelated content unless the user's request calls for a broader rewrite. You may create, rewrite, reorganize, or remove content when that is the clearest interpretation of the request; use clarificationNeeded only when a missing detail makes a correct change impossible. Keep generated claims consistent with the existing academy and any direction in the user's instruction.
Treat the approved build brief and course outline as the current design contract; do not change structure or teaching direction unless the user explicitly asks for it.

For curriculum changes, identify modules and lessons by their zero-based indexes in the supplied academy. Use curriculumPatches for module updates, inserts, deletes, and lessonPatches. Use moduleOrder as a complete zero-based permutation only when the user explicitly asks to reorder modules. Use operation="delete" only when the user's instruction actually requests removal. New modules must include complete lesson objects. Use the existing schema's enum values and field shapes.

For visual requests, map the user's requested course-page color to themeVariant: midnight for blue/cyan, amber for gold/orange, emerald for green, rose for pink/red, violet for purple, and solar for a light theme. Map presentation structure requests to layoutVariant: centered, split, or minimal. These fields control the published landing page and learner experience; they are workspace-controlled settings, not learner edits.

For site changes, return siteConfigPatch with only the requested keys. For academy metadata, landing pages, pricing, SEO, and onboarding, return only the requested fields. Write learner-facing copy directly to the learner using "you"; do not use reporting phrases such as "the speaker said", "the transcript explains", "the source states", or "the material teaches". Never add video lessons when sourceCapabilities.hasVideo is false. Always include a concise summary and a confidence value.`,
      prompt: [
        "CURRENT ACADEMY (complete context):",
        JSON.stringify(academyContext),
        "",
        "CURRENT SITE CONFIG:",
        JSON.stringify(siteConfig ?? {}),
        "",
        "APPROVED BUILD BRIEF:",
        JSON.stringify(buildBrief ?? {}),
        "",
        "APPROVED COURSE OUTLINE:",
        JSON.stringify(coursePlan ?? {}),
        historyBlock,
        "",
        "USER INSTRUCTION:",
        instruction,
      ].join("\n"),
    });

        clearInterval(ping);

        // ── Validation: detect destructive operations ────────────────────────
        const warnings: string[] = [];
        if (object.academyPatch?.curriculumPatches) {
          const moduleDeletes = object.academyPatch.curriculumPatches.filter(p => p.operation === "delete");
          if (moduleDeletes.length > 0) {
            warnings.push(`⚠️ Deleting ${moduleDeletes.length} module(s): ${moduleDeletes.map(p => `Module ${p.moduleIndex + 1}`).join(", ")}`);
          }
          for (const mp of object.academyPatch.curriculumPatches) {
            if (mp.lessonPatches) {
              const lessonDeletes = mp.lessonPatches.filter(lp => lp.operation === "delete");
              if (lessonDeletes.length > 0) {
                warnings.push(`⚠️ Deleting ${lessonDeletes.length} lesson(s) from Module ${mp.moduleIndex + 1}`);
              }
            }
          }
        }
        if (object.academyPatch?.pricing !== undefined && (!object.academyPatch.pricing || object.academyPatch.pricing.length === 0)) {
          warnings.push("⚠️ Clearing pricing information");
        }
        if (object.academyPatch?.onboardingSteps !== undefined && (!object.academyPatch.onboardingSteps || object.academyPatch.onboardingSteps.length === 0)) {
          warnings.push("⚠️ Clearing onboarding steps");
        }

        // ── Dry-run: return patch without applying ───────────────────────────
        if (dryRun) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            dryRun: true,
            patch:   object.academyPatch,
            siteConfigPatch: object.siteConfigPatch,
            summary: object.summary,
            confidence: object.confidence,
            ...(warnings.length > 0 && { warnings }),
            ...(object.clarificationNeeded && { clarificationNeeded: object.clarificationNeeded }),
            academyVersion: currentVersion,
          })}\n\n`));
          controller.close();
          return;
        }

        // ── Confidence gate ─────────────────────────────────────────────
        if (object.confidence === "low" && object.clarificationNeeded) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            needsClarification: true,
            clarificationNeeded: object.clarificationNeeded,
            summary: object.summary,
            confidence: object.confidence,
            ...(warnings.length > 0 && { warnings }),
            academyVersion: currentVersion,
          })}\n\n`));
          controller.close();
          return;
        }

        // Merge patches server-side and return full objects to the client
        let updatedAcademy: AcademyPackage | undefined;
        let updatedSiteConfig: SiteConfig | undefined;

        if (object.academyPatch) {
          updatedAcademy = applyAcademyPatch(academy, object.academyPatch);
        }

        if (object.siteConfigPatch) {
          updatedSiteConfig = applySiteConfigPatch(
            siteConfig ?? SiteConfigSchema.parse({}),
            object.siteConfigPatch,
          );
        }

        // ── Append audit trail entry ───────────────────────────────────────────
        if (updatedAcademy) {
          const entry = {
            timestamp:   new Date().toISOString(),
            instruction: instruction.slice(0, 200),
            summary:     object.summary,
            model:       "v3" as const,
          };
          const existing = (academy.changeLog ?? []) as typeof entry[];
          updatedAcademy = { ...updatedAcademy, changeLog: [...existing, entry].slice(-50) };
        }

        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          academy:        updatedAcademy,
          siteConfig:     updatedSiteConfig,
          summary:        object.summary,
          confidence:     object.confidence,
          academyVersion: updatedAcademy ? computeAcademyVersion(updatedAcademy) : currentVersion,
          ...(warnings.length > 0 && { warnings }),
          ...(object.clarificationNeeded && { clarificationNeeded: object.clarificationNeeded }),
        })}\n\n`));
      } catch (error) {
        clearInterval(ping);
        const message = error instanceof Error ? error.message : "Assistant failed";
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
      "X-Accel-Buffering": "no",
    },
  });
}
