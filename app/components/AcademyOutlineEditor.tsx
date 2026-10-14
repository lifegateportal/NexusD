"use client";

import { useEffect, useState } from "react";
import {
  AcademyOutlineSchema,
  type AcademyOutline,
  type AcademyOutlineLesson,
} from "@/lib/schemas/academy-build";

type Props = {
  outline: AcademyOutline;
  isBuilding: boolean;
  error: string | null;
  onChange: (outline: AcademyOutline) => void;
  onApprove: (outline: AcademyOutline) => void;
  onBack: () => void;
};

const inputClassName = "min-h-12 w-full rounded-xl border border-slate-700 bg-slate-900/70 px-3 text-base text-slate-100 placeholder:text-slate-600 focus:border-cyan-400 focus:outline-none";

function makeLesson(index: number): AcademyOutlineLesson {
  return {
    title: `Lesson ${index + 1}`,
    type: "reading",
    durationMinutes: 20,
    outcome: "",
  };
}

export function AcademyOutlineEditor({
  outline,
  isBuilding,
  error,
  onChange,
  onApprove,
  onBack,
}: Props) {
  const [draft, setDraft] = useState(outline);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(outline);
  }, [outline]);

  function updateDraft(next: AcademyOutline) {
    setDraft(next);
    setValidationError(null);
  }

  function commitDraft(): AcademyOutline | null {
    const parsed = AcademyOutlineSchema.safeParse(draft);
    if (!parsed.success) {
      setValidationError(parsed.error.issues[0]?.message ?? "Please complete the outline before continuing.");
      return null;
    }
    setValidationError(null);
    onChange(parsed.data);
    return parsed.data;
  }

  function approveOutline() {
    const parsed = commitDraft();
    if (parsed) onApprove(parsed);
  }

  function updateModule(index: number, patch: Partial<AcademyOutline["modules"][number]>) {
    updateDraft({
      ...draft,
      modules: draft.modules.map((module, moduleIndex) => (
        moduleIndex === index ? { ...module, ...patch } : module
      )),
    });
  }

  function updateLesson(moduleIndex: number, lessonIndex: number, patch: Partial<AcademyOutlineLesson>) {
    updateModule(moduleIndex, {
      lessons: draft.modules[moduleIndex].lessons.map((lesson, currentIndex) => (
        currentIndex === lessonIndex ? { ...lesson, ...patch } : lesson
      )),
    });
  }

  function moveModule(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= draft.modules.length) return;
    const modules = [...draft.modules];
    [modules[index], modules[target]] = [modules[target], modules[index]];
    updateDraft({ ...draft, modules });
  }

  function removeModule(index: number) {
    if (draft.modules.length <= 1) return;
    updateDraft({ ...draft, modules: draft.modules.filter((_, currentIndex) => currentIndex !== index) });
  }

  function addModule() {
    if (draft.modules.length >= 4) return;
    updateDraft({
      ...draft,
      modules: [
        ...draft.modules,
        {
          moduleTitle: `Module ${draft.modules.length + 1}`,
          moduleDescription: "",
          learningObjectives: [],
          lessons: [makeLesson(0)],
        },
      ],
    });
  }

  function moveLesson(moduleIndex: number, lessonIndex: number, direction: -1 | 1) {
    const lessons = draft.modules[moduleIndex].lessons;
    const target = lessonIndex + direction;
    if (target < 0 || target >= lessons.length) return;
    const nextLessons = [...lessons];
    [nextLessons[lessonIndex], nextLessons[target]] = [nextLessons[target], nextLessons[lessonIndex]];
    updateModule(moduleIndex, { lessons: nextLessons });
  }

  function removeLesson(moduleIndex: number, lessonIndex: number) {
    if (draft.modules[moduleIndex].lessons.length <= 1) return;
    updateModule(moduleIndex, {
      lessons: draft.modules[moduleIndex].lessons.filter((_, currentIndex) => currentIndex !== lessonIndex),
    });
  }

  function addLesson(moduleIndex: number) {
    if (draft.modules[moduleIndex].lessons.length >= 3) return;
    updateModule(moduleIndex, {
      lessons: [
        ...draft.modules[moduleIndex].lessons,
        makeLesson(draft.modules[moduleIndex].lessons.length),
      ],
    });
  }

  const visibleError = error ?? validationError;

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain rounded-2xl border border-cyan-500/20 bg-slate-950/40 p-4 shadow-panel sm:p-5 lg:min-h-0">
      <div className="flex flex-col gap-3 border-b border-slate-800 pb-5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-cyan-400">Outline checkpoint</p>
          <h2 className="mt-1 text-xl font-bold text-slate-100">{draft.courseTitle}</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">
            This is your last structural checkpoint. Edit the sequence and scope before detailed lessons are written.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onBack}
            className="min-h-12 rounded-xl border border-slate-700 px-4 text-sm font-semibold text-slate-300 transition hover:border-slate-500"
          >
            Back to brief
          </button>
          <button
            type="button"
            onClick={() => { commitDraft(); }}
            className="min-h-12 rounded-xl border border-cyan-500/40 bg-cyan-500/10 px-4 text-sm font-semibold text-cyan-300 transition hover:bg-cyan-500/20"
          >
            Save outline
          </button>
        </div>
      </div>

      <div className="grid gap-4 border-b border-slate-800 py-5 lg:grid-cols-2">
        <label className="space-y-2">
          <span className="text-xs font-semibold uppercase tracking-widest text-slate-400">Course title</span>
          <input
            value={draft.courseTitle}
            onChange={(event) => updateDraft({ ...draft, courseTitle: event.target.value })}
            className={inputClassName}
          />
        </label>
        <label className="space-y-2">
          <span className="text-xs font-semibold uppercase tracking-widest text-slate-400">Course summary</span>
          <textarea
            value={draft.courseSummary}
            onChange={(event) => updateDraft({ ...draft, courseSummary: event.target.value })}
            rows={2}
            className={`${inputClassName} resize-y py-3`}
          />
        </label>
      </div>

      <div className="space-y-4 py-5">
        {draft.modules.map((module, moduleIndex) => (
          <article key={`${module.moduleTitle}-${moduleIndex}`} className="rounded-2xl border border-slate-700/60 bg-slate-900/50 p-4">
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">Module {moduleIndex + 1}</p>
                <h3 className="mt-1 text-base font-bold text-slate-100">{module.moduleTitle || "Untitled module"}</h3>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => moveModule(moduleIndex, -1)} disabled={moduleIndex === 0} className="min-h-12 rounded-lg border border-slate-700 px-3 text-xs text-slate-300 disabled:opacity-30">Move up</button>
                <button type="button" onClick={() => moveModule(moduleIndex, 1)} disabled={moduleIndex === draft.modules.length - 1} className="min-h-12 rounded-lg border border-slate-700 px-3 text-xs text-slate-300 disabled:opacity-30">Move down</button>
                <button type="button" onClick={() => removeModule(moduleIndex)} disabled={draft.modules.length <= 1} className="min-h-12 rounded-lg border border-red-500/30 px-3 text-xs text-red-300 disabled:opacity-30">Remove</button>
              </div>
            </div>

            <div className="grid gap-3 lg:grid-cols-2">
              <label className="space-y-2">
                <span className="text-xs font-semibold text-slate-400">Module title</span>
                <input
                  value={module.moduleTitle}
                  onChange={(event) => updateModule(moduleIndex, { moduleTitle: event.target.value })}
                  className={inputClassName}
                />
              </label>
              <label className="space-y-2">
                <span className="text-xs font-semibold text-slate-400">Description</span>
                <textarea
                  value={module.moduleDescription}
                  onChange={(event) => updateModule(moduleIndex, { moduleDescription: event.target.value })}
                  rows={2}
                  className={`${inputClassName} resize-y py-3`}
                />
              </label>
            </div>

            <label className="mt-3 block space-y-2">
              <span className="text-xs font-semibold text-slate-400">Learning objectives, one per line</span>
              <textarea
                value={module.learningObjectives.join("\n")}
                onChange={(event) => updateModule(moduleIndex, {
                  learningObjectives: event.target.value.split("\n").map((item) => item.trim()).filter(Boolean),
                })}
                rows={3}
                className={`${inputClassName} resize-y py-3`}
              />
            </label>

            <div className="mt-5 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">Lessons</p>
                <button
                  type="button"
                  onClick={() => addLesson(moduleIndex)}
                  disabled={module.lessons.length >= 3}
                  className="min-h-12 rounded-lg border border-cyan-500/30 px-3 text-xs font-semibold text-cyan-300 disabled:opacity-30"
                >
                  Add lesson
                </button>
              </div>
              {module.lessons.map((lesson, lessonIndex) => (
                <div key={`${lesson.title}-${lessonIndex}`} className="rounded-xl border border-slate-700/60 bg-slate-950/50 p-3">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-500">Lesson {lessonIndex + 1}</span>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" onClick={() => moveLesson(moduleIndex, lessonIndex, -1)} disabled={lessonIndex === 0} className="min-h-12 rounded-lg border border-slate-700 px-2.5 text-xs text-slate-400 disabled:opacity-30">Up</button>
                      <button type="button" onClick={() => moveLesson(moduleIndex, lessonIndex, 1)} disabled={lessonIndex === module.lessons.length - 1} className="min-h-12 rounded-lg border border-slate-700 px-2.5 text-xs text-slate-400 disabled:opacity-30">Down</button>
                      <button type="button" onClick={() => removeLesson(moduleIndex, lessonIndex)} disabled={module.lessons.length <= 1} className="min-h-12 rounded-lg border border-red-500/30 px-2.5 text-xs text-red-300 disabled:opacity-30">Remove</button>
                    </div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_140px_120px]">
                    <input
                      value={lesson.title}
                      onChange={(event) => updateLesson(moduleIndex, lessonIndex, { title: event.target.value })}
                      placeholder="Lesson title"
                      className={inputClassName}
                    />
                    <select
                      value={lesson.type}
                      onChange={(event) => updateLesson(moduleIndex, lessonIndex, { type: event.target.value as AcademyOutlineLesson["type"] })}
                      className={inputClassName}
                    >
                      <option value="video">Video</option>
                      <option value="reading">Reading</option>
                      <option value="quiz">Quiz</option>
                      <option value="exercise">Exercise</option>
                    </select>
                    <input
                      type="number"
                      min={1}
                      max={240}
                      value={lesson.durationMinutes}
                      onChange={(event) => updateLesson(moduleIndex, lessonIndex, { durationMinutes: Number(event.target.value) })}
                      className={inputClassName}
                      aria-label="Lesson duration in minutes"
                    />
                  </div>
                  <input
                    value={lesson.outcome}
                    onChange={(event) => updateLesson(moduleIndex, lessonIndex, { outcome: event.target.value })}
                    placeholder="Learner outcome for this lesson"
                    className={`${inputClassName} mt-3`}
                  />
                </div>
              ))}
            </div>
          </article>
        ))}
        <button
          type="button"
          onClick={addModule}
          disabled={draft.modules.length >= 4}
          className="min-h-12 w-full rounded-xl border border-dashed border-cyan-500/40 text-sm font-semibold text-cyan-300 transition hover:bg-cyan-500/10 disabled:opacity-30"
        >
          Add module
        </button>
      </div>

      {visibleError && (
        <p role="alert" className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {visibleError}
        </p>
      )}

      <div className="flex flex-col gap-3 border-t border-slate-800 pt-5 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs leading-5 text-slate-500">
          {draft.modules.length} modules · {draft.modules.reduce((total, module) => total + module.lessons.length, 0)} lessons
        </p>
        <button
          type="button"
          onClick={approveOutline}
          disabled={isBuilding}
          className="min-h-12 rounded-xl bg-cyan-500 px-5 text-sm font-bold text-slate-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500"
        >
          {isBuilding ? "Building course…" : "Approve outline & build course"}
        </button>
      </div>
    </section>
  );
}
