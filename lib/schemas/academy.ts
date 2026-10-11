import { z } from "zod";

export const ProduceInputSchema = z.object({
  title: z.string(),
  summary: z.string(),
  assets: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      type: z.string(),
      durationMs: z.number().optional(),
      tags: z.array(z.string()).default([]),
    })
  ),
  workflow: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      intent: z.string(),
    })
  ),
  executionPlan: z.array(
    z.object({
      step: z.number(),
      title: z.string(),
      action: z.string(),
      expectedOutcome: z.string(),
    })
  ),
  entities: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      category: z.string(),
    })
  ),
  visualDirection: z.string(),
  rawTranscript: z.string().optional(),
  deliveryInstructions: z.string().optional(),
});

export const AcademyPackageSchema = z.object({
  academyName: z.string(),
  tagline: z.string(),
  targetAudience: z.string(),
  sourceCapabilities: z.object({
    hasVideo: z.boolean().default(false),
  }).default({}),
  difficultyLevel: z.enum(["beginner", "intermediate", "advanced"]).default("intermediate"),
  totalEstimatedHours: z.number().default(0),
  certificateTitle: z.string().default(""),
  themeVariant: z.enum(["midnight", "amber", "emerald", "rose", "violet", "solar"]).default("midnight"),
  layoutVariant: z.enum(["centered", "split", "minimal"]).default("centered"),
  landingPage: z.object({
    headline: z.string(),
    subheadline: z.string(),
    problemStatement: z.string(),
    features: z.array(
      z.object({
        title: z.string(),
        description: z.string(),
      })
    ),
    cta: z.string(),
  }),
  pricing: z.array(
    z.object({
      name: z.string(),
      priceUsd: z.number(),
      period: z.enum(["once", "monthly", "yearly"]),
      features: z.array(z.string()),
    })
  ),
  curriculum: z.array(
    z.object({
      moduleTitle: z.string(),
      moduleDescription: z.string(),
      learningObjectives: z.array(z.string()).default([]),
      keyTerms: z.array(
        z.object({
          term: z.string(),
          definition: z.string(),
        })
      ).default([]),
      lessons: z.array(
        z.object({
          title: z.string(),
          type: z.enum(["video", "reading", "quiz", "exercise"]),
          durationMinutes: z.number(),
          description: z.string(),
          notes: z.string().default(""),
          keyTakeaways: z.array(z.string()).default([]),
          actionItems: z.array(z.string()).default([]),
          quiz: z.array(
            z.object({
              q: z.string(),
              options: z.array(z.string()),
              correct: z.number().int().min(0).max(3),
            })
          ).default([]),
        })
      ),
    })
  ),
  seoMeta: z.object({
    title: z.string(),
    description: z.string(),
    keywords: z.array(z.string()),
  }),
  onboardingSteps: z.array(z.string()),
  /** Audit trail — rolling log of every assistant edit (max 50 entries, oldest dropped first) */
  changeLog: z.array(z.object({
    timestamp:   z.string().datetime(),
    instruction: z.string(),
    summary:     z.string(),
    model:       z.enum(["v3", "r1"]),
  })).max(50).optional(),
});

export type ProduceInput = z.infer<typeof ProduceInputSchema>;
export type AcademyPackage = z.infer<typeof AcademyPackageSchema>;

// ── Fragmented generation schemas ─────────────────────────────────────────────
// Phase 1: full academy structure with lightweight lesson stubs (no notes/quiz).
// Keeps DeepSeek Phase 1 output well under 8K tokens.

// Minimal stub used in Phase 1 — description/notes generated in Phase 2.
const LessonOutlineSchema = z.object({
  title: z.string(),
  type: z.enum(["video", "reading", "quiz", "exercise"]),
  durationMinutes: z.number(),
});

export const AcademyShellSchema = z.object({
  academyName: z.string(),
  tagline: z.string(),
  targetAudience: z.string(),
  difficultyLevel: z.enum(["beginner", "intermediate", "advanced"]).default("intermediate"),
  totalEstimatedHours: z.number().default(0),
  certificateTitle: z.string().default(""),
  themeVariant: z.enum(["midnight", "amber", "emerald", "rose", "violet", "solar"]).default("midnight"),
  layoutVariant: z.enum(["centered", "split", "minimal"]).default("centered"),
  landingPage: z.object({
    headline: z.string(),
    subheadline: z.string(),
    problemStatement: z.string(),
    features: z.array(z.object({ title: z.string(), description: z.string() })),
    cta: z.string(),
  }),
  pricing: z.array(z.object({
    name: z.string(),
    priceUsd: z.number(),
    period: z.enum(["once", "monthly", "yearly"]),
    features: z.array(z.string()),
  })),
  // learningObjectives and keyTerms are deferred to Phase 2 to keep this
  // call well under DeepSeek's 8K output limit.
  // Hard caps: max 4 modules, max 3 lesson stubs per module.
  curriculum: z.array(z.object({
    moduleTitle: z.string(),
    moduleDescription: z.string(),
    lessonOutlines: z.array(LessonOutlineSchema).max(3),
  })).max(4),
  seoMeta: z.object({
    title: z.string(),
    description: z.string(),
    keywords: z.array(z.string()),
  }),
  onboardingSteps: z.array(z.string()),
});

// Phase 2: module metadata + full lesson content (per-module API call).
// learningObjectives and keyTerms are generated here alongside lesson notes
// so all detailed prose is spread across multiple bounded calls.
export const ModuleLessonsSchema = z.object({
  learningObjectives: z.array(z.string()).default([]),
  keyTerms: z.array(z.object({ term: z.string(), definition: z.string() })).default([]),
  lessons: z.array(z.object({
    title: z.string(),
    type: z.enum(["video", "reading", "quiz", "exercise"]),
    durationMinutes: z.number(),
    description: z.string(),
    notes: z.string().default(""),
    keyTakeaways: z.array(z.string()).default([]),
    actionItems: z.array(z.string()).default([]),
    quiz: z.array(z.object({
      q: z.string(),
      options: z.array(z.string()),
      correct: z.number().int().min(0).max(3),
    })).default([]),
  })),
});

// Phase 2a: per-module metadata only (no prose → tiny output).
export const ModuleMetaSchema = z.object({
  learningObjectives: z.array(z.string()),
  keyTerms: z.array(z.object({ term: z.string(), definition: z.string() })),
});

// Phase 2b: one lesson at a time — guaranteed < 800 tokens output.
export const SingleLessonSchema = z.object({
  description: z.string(),
  notes: z.string(),
  keyTakeaways: z.array(z.string()),
  actionItems: z.array(z.string()),
  quiz: z.array(z.object({
    q: z.string(),
    options: z.array(z.string()),
    correct: z.number().int().min(0).max(3),
  })),
});

// Phase 2b-structured: lesson fields WITHOUT notes.
// Used with generateObject so only small, countable tokens are in JSON.
// Notes are generated separately via generateText to avoid JSON parse errors.
export const LessonStructuredSchema = z.object({
  description: z.string(),
  keyTakeaways: z.array(z.string()),
  actionItems: z.array(z.string()),
  quiz: z.array(z.object({
    q: z.string(),
    options: z.array(z.string()),
    correct: z.number().int().min(0).max(3),
  })),
});

export type AcademyShell = z.infer<typeof AcademyShellSchema>;
export type ModuleLessons = z.infer<typeof ModuleLessonsSchema>;
export type ModuleMeta = z.infer<typeof ModuleMetaSchema>;
export type SingleLesson = z.infer<typeof SingleLessonSchema>;
export type LessonStructured = z.infer<typeof LessonStructuredSchema>;
