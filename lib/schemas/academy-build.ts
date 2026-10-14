import { z } from "zod";

export const AcademyLessonTypeSchema = z.enum(["video", "reading", "quiz", "exercise"]);

export const AcademyBuildBriefSchema = z.object({
  audience: z.string().default(""),
  learningOutcome: z.string().default(""),
  difficultyLevel: z.enum(["beginner", "intermediate", "advanced"]).default("intermediate"),
  moduleCount: z.number().int().min(1).max(4).default(3),
  lessonsPerModule: z.number().int().min(1).max(3).default(3),
  targetLessonMinutes: z.number().int().min(5).max(180).default(20),
  allowedLessonTypes: z.array(AcademyLessonTypeSchema).min(1).default(["reading", "quiz", "exercise"]),
  tone: z.string().default("Practical, clear, and encouraging"),
  includeQuizzes: z.boolean().default(true),
  includeExercises: z.boolean().default(true),
  includeCertificate: z.boolean().default(false),
  sourceFidelity: z.enum(["strict", "balanced", "creative"]).default("balanced"),
  notes: z.string().max(4000).default(""),
}).strict();

export const AcademyOutlineLessonSchema = z.object({
  title: z.string().min(1),
  type: AcademyLessonTypeSchema,
  durationMinutes: z.number().int().min(1).max(240),
  outcome: z.string().default(""),
}).strict();

export const AcademyOutlineModuleSchema = z.object({
  moduleTitle: z.string().min(1),
  moduleDescription: z.string().default(""),
  learningObjectives: z.array(z.string()).default([]),
  lessons: z.array(AcademyOutlineLessonSchema).min(1),
}).strict();

export const AcademyOutlineSchema = z.object({
  courseTitle: z.string().min(1),
  courseSummary: z.string().default(""),
  modules: z.array(AcademyOutlineModuleSchema).min(1).max(8),
}).strict();

export type AcademyBuildBrief = z.infer<typeof AcademyBuildBriefSchema>;
export type AcademyOutlineLesson = z.infer<typeof AcademyOutlineLessonSchema>;
export type AcademyOutlineModule = z.infer<typeof AcademyOutlineModuleSchema>;
export type AcademyOutline = z.infer<typeof AcademyOutlineSchema>;

export function defaultAcademyBuildBrief(hasVideoSource = false): AcademyBuildBrief {
  return AcademyBuildBriefSchema.parse({
    allowedLessonTypes: hasVideoSource
      ? ["video", "reading", "quiz", "exercise"]
      : ["reading", "quiz", "exercise"],
  });
}

export function recommendAcademyBuildBrief(
  sourceSummary: string,
  hasVideoSource: boolean,
): AcademyBuildBrief {
  const summary = sourceSummary.trim();
  return AcademyBuildBriefSchema.parse({
    ...defaultAcademyBuildBrief(hasVideoSource),
    audience: "Learners who want a practical understanding of this subject",
    learningOutcome: summary
      ? `Apply the main ideas from this material in a clear, practical way.`
      : "Apply the main ideas in a clear, practical way.",
    notes: "Keep each lesson focused on one teachable idea and end with a concrete next step.",
  });
}

export function isAcademyBuildBriefConfigured(brief: AcademyBuildBrief): boolean {
  return brief.audience.trim().length > 0
    && brief.learningOutcome.trim().length > 0
    && brief.allowedLessonTypes.length > 0;
}
