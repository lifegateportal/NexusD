"use client";

import { useState } from "react";
import {
  AcademyBuildBriefSchema,
  AcademyLessonTypeSchema,
  type AcademyBuildBrief,
} from "@/lib/schemas/academy-build";

type Props = {
  brief: AcademyBuildBrief;
  sourceTitle: string;
  hasVideoSource: boolean;
  isGenerating: boolean;
  error: string | null;
  onChange: (brief: AcademyBuildBrief) => void;
  onRecommend: () => void;
  onGenerateOutline: () => void;
};

const LESSON_TYPES = [
  { value: "video", label: "Video", description: "Teach from source footage" },
  { value: "reading", label: "Reading", description: "Guided notes and examples" },
  { value: "quiz", label: "Quiz", description: "Check understanding" },
  { value: "exercise", label: "Exercise", description: "Practice the skill" },
] as const;

function fieldClassName() {
  return "min-h-12 w-full rounded-xl border border-slate-700 bg-slate-900/70 px-4 text-base text-slate-100 placeholder:text-slate-600 focus:border-cyan-400 focus:outline-none";
}

export function AcademyBuildBrief({
  brief,
  sourceTitle,
  hasVideoSource,
  isGenerating,
  error,
  onChange,
  onRecommend,
  onGenerateOutline,
}: Props) {
  const [validationError, setValidationError] = useState<string | null>(null);

  function update<K extends keyof AcademyBuildBrief>(key: K, value: AcademyBuildBrief[K]) {
    const parsed = AcademyBuildBriefSchema.safeParse({ ...brief, [key]: value });
    if (!parsed.success) {
      setValidationError(parsed.error.issues[0]?.message ?? "Please check this field.");
      return;
    }
    setValidationError(null);
    onChange(parsed.data);
  }

  function toggleLessonType(value: AcademyBuildBrief["allowedLessonTypes"][number]) {
    if (value === "video" && !hasVideoSource) return;
    const current = new Set(brief.allowedLessonTypes);
    if (current.has(value)) current.delete(value);
    else current.add(value);
    const parsed = AcademyBuildBriefSchema.safeParse({
      ...brief,
      allowedLessonTypes: Array.from(current).map((item) => AcademyLessonTypeSchema.parse(item)),
    });
    if (!parsed.success) {
      setValidationError("Choose at least one lesson type.");
      return;
    }
    setValidationError(null);
    onChange(parsed.data);
  }

  const visibleError = error ?? validationError;
  const canGenerate = brief.audience.trim().length > 0
    && brief.learningOutcome.trim().length > 0
    && brief.allowedLessonTypes.length > 0
    && !isGenerating;

  return (
    <section className="flex min-h-0 flex-col overflow-y-auto rounded-2xl border border-cyan-500/20 bg-slate-950/40 p-4 shadow-panel sm:p-5">
      <div className="flex flex-col gap-3 border-b border-slate-800 pb-5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-cyan-400">Define the course</p>
          <h2 className="mt-1 text-xl font-bold text-slate-100">How should “{sourceTitle}” become a course?</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">
            Set the learner, promise, structure, and teaching style before Nexus generates an outline.
          </p>
        </div>
        <button
          type="button"
          onClick={onRecommend}
          className="min-h-12 shrink-0 rounded-xl border border-cyan-500/40 bg-cyan-500/10 px-4 text-sm font-semibold text-cyan-300 transition hover:bg-cyan-500/20"
        >
          Recommend a setup
        </button>
      </div>

      <div className="grid gap-5 py-5 lg:grid-cols-2">
        <label className="space-y-2">
          <span className="text-xs font-semibold uppercase tracking-widest text-slate-400">Who is this for?</span>
          <textarea
            value={brief.audience}
            onChange={(event) => update("audience", event.target.value)}
            rows={3}
            placeholder="e.g. New ministry leaders who need a repeatable way to prepare a message"
            className={`${fieldClassName()} resize-y py-3`}
          />
        </label>
        <label className="space-y-2">
          <span className="text-xs font-semibold uppercase tracking-widest text-slate-400">What should learners be able to do?</span>
          <textarea
            value={brief.learningOutcome}
            onChange={(event) => update("learningOutcome", event.target.value)}
            rows={3}
            placeholder="e.g. Plan and deliver a clear message using the method in the source"
            className={`${fieldClassName()} resize-y py-3`}
          />
        </label>
      </div>

      <div className="grid gap-4 border-t border-slate-800 py-5 sm:grid-cols-2 lg:grid-cols-4">
        <label className="space-y-2">
          <span className="text-xs font-semibold uppercase tracking-widest text-slate-400">Difficulty</span>
          <select
            value={brief.difficultyLevel}
            onChange={(event) => update("difficultyLevel", event.target.value as AcademyBuildBrief["difficultyLevel"])}
            className={fieldClassName()}
          >
            <option value="beginner">Beginner</option>
            <option value="intermediate">Intermediate</option>
            <option value="advanced">Advanced</option>
          </select>
        </label>
        <label className="space-y-2">
          <span className="text-xs font-semibold uppercase tracking-widest text-slate-400">Modules</span>
          <select
            value={brief.moduleCount}
            onChange={(event) => update("moduleCount", Number(event.target.value))}
            className={fieldClassName()}
          >
            {[1, 2, 3, 4].map((count) => <option key={count} value={count}>{count}</option>)}
          </select>
        </label>
        <label className="space-y-2">
          <span className="text-xs font-semibold uppercase tracking-widest text-slate-400">Lessons per module</span>
          <select
            value={brief.lessonsPerModule}
            onChange={(event) => update("lessonsPerModule", Number(event.target.value))}
            className={fieldClassName()}
          >
            {[1, 2, 3].map((count) => <option key={count} value={count}>{count}</option>)}
          </select>
        </label>
        <label className="space-y-2">
          <span className="text-xs font-semibold uppercase tracking-widest text-slate-400">Minutes per lesson</span>
          <select
            value={brief.targetLessonMinutes}
            onChange={(event) => update("targetLessonMinutes", Number(event.target.value))}
            className={fieldClassName()}
          >
            {[10, 15, 20, 30, 45, 60].map((minutes) => <option key={minutes} value={minutes}>{minutes}</option>)}
          </select>
        </label>
      </div>

      <div className="grid gap-5 border-t border-slate-800 py-5 lg:grid-cols-2">
        <div>
          <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-slate-400">Lesson ingredients</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {LESSON_TYPES.map((lessonType) => {
              const disabled = lessonType.value === "video" && !hasVideoSource;
              const selected = brief.allowedLessonTypes.includes(lessonType.value);
              return (
                <button
                  key={lessonType.value}
                  type="button"
                  disabled={disabled}
                  onClick={() => toggleLessonType(lessonType.value)}
                  className={[
                    "min-h-12 rounded-xl border px-3 py-2 text-left transition",
                    selected
                      ? "border-cyan-400/50 bg-cyan-500/10 text-cyan-200"
                      : "border-slate-700 bg-slate-900/50 text-slate-400",
                    disabled ? "cursor-not-allowed opacity-40" : "hover:border-cyan-500/50",
                  ].join(" ")}
                >
                  <span className="block text-sm font-semibold">{lessonType.label}</span>
                  <span className="block text-[11px] text-slate-500">
                    {disabled ? "Requires a video source" : lessonType.description}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        <label className="space-y-2">
          <span className="text-xs font-semibold uppercase tracking-widest text-slate-400">Teaching tone</span>
          <textarea
            value={brief.tone}
            onChange={(event) => update("tone", event.target.value)}
            rows={4}
            placeholder="e.g. Warm, direct, practical, and theologically careful"
            className={`${fieldClassName()} resize-y py-3`}
          />
        </label>
      </div>

      <div className="grid gap-5 border-t border-slate-800 py-5 lg:grid-cols-2">
        <div className="space-y-3">
          <label className="space-y-2">
            <span className="text-xs font-semibold uppercase tracking-widest text-slate-400">Source fidelity</span>
            <select
              value={brief.sourceFidelity}
              onChange={(event) => update("sourceFidelity", event.target.value as AcademyBuildBrief["sourceFidelity"])}
              className={fieldClassName()}
            >
              <option value="strict">Strict — stay close to the source</option>
              <option value="balanced">Balanced — clarify and frame where useful</option>
              <option value="creative">Creative — expand into a broader learning experience</option>
            </select>
          </label>
          <label className="flex min-h-12 items-center gap-3 rounded-xl border border-slate-700 bg-slate-900/50 px-4">
            <input
              type="checkbox"
              checked={brief.includeQuizzes}
              onChange={(event) => update("includeQuizzes", event.target.checked)}
              className="h-5 w-5 accent-cyan-400"
            />
            <span className="text-sm text-slate-300">Include knowledge checks</span>
          </label>
          <label className="flex min-h-12 items-center gap-3 rounded-xl border border-slate-700 bg-slate-900/50 px-4">
            <input
              type="checkbox"
              checked={brief.includeExercises}
              onChange={(event) => update("includeExercises", event.target.checked)}
              className="h-5 w-5 accent-cyan-400"
            />
            <span className="text-sm text-slate-300">Include practical exercises</span>
          </label>
          <label className="flex min-h-12 items-center gap-3 rounded-xl border border-slate-700 bg-slate-900/50 px-4">
            <input
              type="checkbox"
              checked={brief.includeCertificate}
              onChange={(event) => update("includeCertificate", event.target.checked)}
              className="h-5 w-5 accent-cyan-400"
            />
            <span className="text-sm text-slate-300">Plan for a completion certificate</span>
          </label>
        </div>
        <label className="space-y-2">
          <span className="text-xs font-semibold uppercase tracking-widest text-slate-400">Additional constraints</span>
          <textarea
            value={brief.notes}
            onChange={(event) => update("notes", event.target.value)}
            rows={8}
            placeholder="Add required topics, exclusions, examples, or editorial rules."
            className={`${fieldClassName()} resize-y py-3`}
          />
        </label>
      </div>

      {visibleError && (
        <p role="alert" className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {visibleError}
        </p>
      )}

      <div className="flex flex-col gap-3 border-t border-slate-800 pt-5 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs leading-5 text-slate-500">
          You can change every part of the outline before detailed lesson content is generated.
        </p>
        <button
          type="button"
          onClick={onGenerateOutline}
          disabled={!canGenerate}
          className="min-h-12 rounded-xl bg-cyan-500 px-5 text-sm font-bold text-slate-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500"
        >
          {isGenerating ? "Generating outline…" : "Save brief & generate outline"}
        </button>
      </div>
    </section>
  );
}
