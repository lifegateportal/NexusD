"use client";

import { useEffect, useState } from "react";
import { AcademyPackageSchema, type AcademyPackage } from "@/lib/schemas/academy";

type Props = {
  academy: AcademyPackage;
  saving: boolean;
  error: string | null;
  onSave: (academy: AcademyPackage) => void | Promise<void>;
};

type Lesson = AcademyPackage["curriculum"][number]["lessons"][number];
type QuizItem = Lesson["quiz"][number];

const inputClassName = "min-h-12 w-full rounded-xl border border-slate-700 bg-slate-900/70 px-3 text-base text-slate-100 placeholder:text-slate-600 focus:border-cyan-400 focus:outline-none";

function lines(value: string): string[] {
  return value.split("\n").map((item) => item.trim()).filter(Boolean);
}

export function AcademyCourseEditor({ academy, saving, error, onSave }: Props) {
  const [draft, setDraft] = useState(academy);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(academy);
  }, [academy]);

  function updateDraft(patch: Partial<AcademyPackage>) {
    setDraft((current) => ({ ...current, ...patch }));
    setValidationError(null);
  }

  function updateModule(index: number, patch: Partial<AcademyPackage["curriculum"][number]>) {
    updateDraft({
      curriculum: draft.curriculum.map((module, moduleIndex) => (
        moduleIndex === index ? { ...module, ...patch } : module
      )),
    });
  }

  function updateLesson(moduleIndex: number, lessonIndex: number, patch: Partial<Lesson>) {
    updateModule(moduleIndex, {
      lessons: draft.curriculum[moduleIndex].lessons.map((lesson, currentIndex) => (
        currentIndex === lessonIndex ? { ...lesson, ...patch } : lesson
      )),
    });
  }

  function updateQuiz(
    moduleIndex: number,
    lessonIndex: number,
    quizIndex: number,
    patch: Partial<QuizItem>,
  ) {
    const lesson = draft.curriculum[moduleIndex].lessons[lessonIndex];
    updateLesson(moduleIndex, lessonIndex, {
      quiz: lesson.quiz.map((item, currentIndex) => (
        currentIndex === quizIndex ? { ...item, ...patch } : item
      )),
    });
  }

  function save() {
    const parsed = AcademyPackageSchema.safeParse(draft);
    if (!parsed.success) {
      setValidationError(parsed.error.issues[0]?.message ?? "Please fix the course before saving.");
      return;
    }
    setValidationError(null);
    void onSave(parsed.data);
  }

  const visibleError = error ?? validationError;

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain rounded-2xl border border-cyan-500/20 bg-slate-950/40 p-4 shadow-panel sm:p-5 lg:min-h-0">
      <div className="flex flex-col gap-3 border-b border-slate-800 pb-5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-cyan-400">Course studio</p>
          <h2 className="mt-1 text-xl font-bold text-slate-100">Edit before you publish</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">
            Changes are validated and saved to the current Academy project. Publishing remains a separate deliberate step.
          </p>
        </div>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="min-h-12 shrink-0 rounded-xl bg-cyan-500 px-5 text-sm font-bold text-slate-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500"
        >
          {saving ? "Saving course…" : "Save course changes"}
        </button>
      </div>

      <div className="space-y-5 py-5">
        <section className="rounded-2xl border border-slate-700/60 bg-slate-900/50 p-4">
          <h3 className="mb-4 text-sm font-bold uppercase tracking-widest text-slate-300">Course identity</h3>
          <div className="grid gap-3 lg:grid-cols-2">
            <label className="space-y-2">
              <span className="text-xs font-semibold text-slate-400">Academy name</span>
              <input value={draft.academyName} onChange={(event) => updateDraft({ academyName: event.target.value })} className={inputClassName} />
            </label>
            <label className="space-y-2">
              <span className="text-xs font-semibold text-slate-400">Tagline</span>
              <input value={draft.tagline} onChange={(event) => updateDraft({ tagline: event.target.value })} className={inputClassName} />
            </label>
            <label className="space-y-2">
              <span className="text-xs font-semibold text-slate-400">Target audience</span>
              <textarea value={draft.targetAudience} onChange={(event) => updateDraft({ targetAudience: event.target.value })} rows={2} className={`${inputClassName} resize-y py-3`} />
            </label>
            <label className="space-y-2">
              <span className="text-xs font-semibold text-slate-400">Difficulty</span>
              <select value={draft.difficultyLevel} onChange={(event) => updateDraft({ difficultyLevel: event.target.value as AcademyPackage["difficultyLevel"] })} className={inputClassName}>
                <option value="beginner">Beginner</option>
                <option value="intermediate">Intermediate</option>
                <option value="advanced">Advanced</option>
              </select>
            </label>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-700/60 bg-slate-900/50 p-4">
          <h3 className="mb-4 text-sm font-bold uppercase tracking-widest text-slate-300">Landing page</h3>
          <div className="grid gap-3 lg:grid-cols-2">
            <label className="space-y-2">
              <span className="text-xs font-semibold text-slate-400">Headline</span>
              <input value={draft.landingPage.headline} onChange={(event) => updateDraft({ landingPage: { ...draft.landingPage, headline: event.target.value } })} className={inputClassName} />
            </label>
            <label className="space-y-2">
              <span className="text-xs font-semibold text-slate-400">Call to action</span>
              <input value={draft.landingPage.cta} onChange={(event) => updateDraft({ landingPage: { ...draft.landingPage, cta: event.target.value } })} className={inputClassName} />
            </label>
            <label className="space-y-2">
              <span className="text-xs font-semibold text-slate-400">Subheadline</span>
              <textarea value={draft.landingPage.subheadline} onChange={(event) => updateDraft({ landingPage: { ...draft.landingPage, subheadline: event.target.value } })} rows={2} className={`${inputClassName} resize-y py-3`} />
            </label>
            <label className="space-y-2">
              <span className="text-xs font-semibold text-slate-400">Problem statement</span>
              <textarea value={draft.landingPage.problemStatement} onChange={(event) => updateDraft({ landingPage: { ...draft.landingPage, problemStatement: event.target.value } })} rows={2} className={`${inputClassName} resize-y py-3`} />
            </label>
          </div>
          <label className="mt-3 block space-y-2">
            <span className="text-xs font-semibold text-slate-400">Feature title and description, one per line as “title — description”</span>
            <textarea
              value={draft.landingPage.features.map((feature) => `${feature.title} — ${feature.description}`).join("\n")}
              onChange={(event) => updateDraft({
                landingPage: {
                  ...draft.landingPage,
                  features: lines(event.target.value).map((value) => {
                    const [title, ...description] = value.split("—");
                    return { title: title.trim(), description: description.join("—").trim() };
                  }),
                },
              })}
              rows={4}
              className={`${inputClassName} resize-y py-3`}
            />
          </label>
        </section>

        <section className="rounded-2xl border border-slate-700/60 bg-slate-900/50 p-4">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h3 className="text-sm font-bold uppercase tracking-widest text-slate-300">Curriculum</h3>
            <span className="text-xs text-slate-500">{draft.curriculum.length} modules</span>
          </div>
          <div className="space-y-4">
            {draft.curriculum.map((module, moduleIndex) => (
              <article key={`${module.moduleTitle}-${moduleIndex}`} className="rounded-xl border border-slate-700/60 bg-slate-950/50 p-3">
                <div className="grid gap-3 lg:grid-cols-2">
                  <label className="space-y-2">
                    <span className="text-xs font-semibold text-slate-400">Module {moduleIndex + 1} title</span>
                    <input value={module.moduleTitle} onChange={(event) => updateModule(moduleIndex, { moduleTitle: event.target.value })} className={inputClassName} />
                  </label>
                  <label className="space-y-2">
                    <span className="text-xs font-semibold text-slate-400">Module description</span>
                    <textarea value={module.moduleDescription} onChange={(event) => updateModule(moduleIndex, { moduleDescription: event.target.value })} rows={2} className={`${inputClassName} resize-y py-3`} />
                  </label>
                </div>
                <label className="mt-3 block space-y-2">
                  <span className="text-xs font-semibold text-slate-400">Learning objectives, one per line</span>
                  <textarea value={module.learningObjectives.join("\n")} onChange={(event) => updateModule(moduleIndex, { learningObjectives: lines(event.target.value) })} rows={3} className={`${inputClassName} resize-y py-3`} />
                </label>
                <div className="mt-4 space-y-3">
                  {module.lessons.map((lesson, lessonIndex) => (
                    <div key={`${lesson.title}-${lessonIndex}`} className="rounded-xl border border-slate-800 bg-slate-900/70 p-3">
                      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_130px_110px]">
                        <label className="space-y-2">
                          <span className="text-xs font-semibold text-slate-400">Lesson {lessonIndex + 1}</span>
                          <input value={lesson.title} onChange={(event) => updateLesson(moduleIndex, lessonIndex, { title: event.target.value })} className={inputClassName} />
                        </label>
                        <label className="space-y-2">
                          <span className="text-xs font-semibold text-slate-400">Type</span>
                          <select value={lesson.type} onChange={(event) => updateLesson(moduleIndex, lessonIndex, { type: event.target.value as Lesson["type"] })} className={inputClassName}>
                            <option value="video">Video</option>
                            <option value="reading">Reading</option>
                            <option value="quiz">Quiz</option>
                            <option value="exercise">Exercise</option>
                          </select>
                        </label>
                        <label className="space-y-2">
                          <span className="text-xs font-semibold text-slate-400">Minutes</span>
                          <input type="number" min={1} value={lesson.durationMinutes} onChange={(event) => updateLesson(moduleIndex, lessonIndex, { durationMinutes: Number(event.target.value) })} className={inputClassName} />
                        </label>
                      </div>
                      <label className="mt-3 block space-y-2">
                        <span className="text-xs font-semibold text-slate-400">Description</span>
                        <textarea value={lesson.description} onChange={(event) => updateLesson(moduleIndex, lessonIndex, { description: event.target.value })} rows={2} className={`${inputClassName} resize-y py-3`} />
                      </label>
                      <label className="mt-3 block space-y-2">
                        <span className="text-xs font-semibold text-slate-400">Notes</span>
                        <textarea value={lesson.notes} onChange={(event) => updateLesson(moduleIndex, lessonIndex, { notes: event.target.value })} rows={7} className={`${inputClassName} resize-y py-3`} />
                      </label>
                      <div className="grid gap-3 mt-3 lg:grid-cols-2">
                        <label className="space-y-2">
                          <span className="text-xs font-semibold text-slate-400">Key takeaways, one per line</span>
                          <textarea value={lesson.keyTakeaways.join("\n")} onChange={(event) => updateLesson(moduleIndex, lessonIndex, { keyTakeaways: lines(event.target.value) })} rows={4} className={`${inputClassName} resize-y py-3`} />
                        </label>
                        <label className="space-y-2">
                          <span className="text-xs font-semibold text-slate-400">Action items, one per line</span>
                          <textarea value={lesson.actionItems.join("\n")} onChange={(event) => updateLesson(moduleIndex, lessonIndex, { actionItems: lines(event.target.value) })} rows={4} className={`${inputClassName} resize-y py-3`} />
                        </label>
                      </div>

                      <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/50 p-3">
                        <div className="mb-3 flex items-center justify-between gap-2">
                          <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">Quiz questions</p>
                          <button
                            type="button"
                            onClick={() => updateLesson(moduleIndex, lessonIndex, {
                              quiz: [...lesson.quiz, { q: "New question", options: ["Option 1", "Option 2", "Option 3", "Option 4"], correct: 0 }],
                            })}
                            className="min-h-12 rounded-lg border border-cyan-500/30 px-3 text-xs font-semibold text-cyan-300"
                          >
                            Add question
                          </button>
                        </div>
                        {lesson.quiz.length === 0 && <p className="text-xs text-slate-600">No quiz questions yet.</p>}
                        <div className="space-y-3">
                          {lesson.quiz.map((item, quizIndex) => (
                            <div key={`${quizIndex}-${item.q}`} className="rounded-lg border border-slate-800 p-3">
                              <div className="flex items-start gap-2">
                                <textarea value={item.q} onChange={(event) => updateQuiz(moduleIndex, lessonIndex, quizIndex, { q: event.target.value })} rows={2} className={`${inputClassName} resize-y py-3`} />
                                <button
                                  type="button"
                                  onClick={() => updateLesson(moduleIndex, lessonIndex, { quiz: lesson.quiz.filter((_, currentIndex) => currentIndex !== quizIndex) })}
                                  className="flex min-h-12 min-w-12 items-center justify-center rounded-lg border border-red-500/30 text-sm text-red-300"
                                  aria-label={`Remove quiz question ${quizIndex + 1}`}
                                >
                                  ×
                                </button>
                              </div>
                              <textarea
                                value={item.options.join("\n")}
                                onChange={(event) => updateQuiz(moduleIndex, lessonIndex, quizIndex, { options: lines(event.target.value) })}
                                rows={4}
                                placeholder="One option per line"
                                className={`${inputClassName} mt-2 resize-y py-3`}
                              />
                              <label className="mt-2 flex min-h-12 items-center gap-3 text-xs text-slate-400">
                                Correct option
                                <select value={item.correct} onChange={(event) => updateQuiz(moduleIndex, lessonIndex, quizIndex, { correct: Number(event.target.value) })} className="min-h-12 rounded-lg border border-slate-700 bg-slate-900 px-3 text-base text-slate-200">
                                  {item.options.slice(0, 4).map((option, optionIndex) => <option key={`${option}-${optionIndex}`} value={optionIndex}>{optionIndex + 1}: {option || "Empty option"}</option>)}
                                </select>
                              </label>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="grid gap-5 lg:grid-cols-2">
          <div className="rounded-2xl border border-slate-700/60 bg-slate-900/50 p-4">
            <h3 className="mb-4 text-sm font-bold uppercase tracking-widest text-slate-300">SEO</h3>
            <div className="space-y-3">
              <input value={draft.seoMeta.title} onChange={(event) => updateDraft({ seoMeta: { ...draft.seoMeta, title: event.target.value } })} placeholder="SEO title" className={inputClassName} />
              <textarea value={draft.seoMeta.description} onChange={(event) => updateDraft({ seoMeta: { ...draft.seoMeta, description: event.target.value } })} rows={3} placeholder="SEO description" className={`${inputClassName} resize-y py-3`} />
              <textarea value={draft.seoMeta.keywords.join("\n")} onChange={(event) => updateDraft({ seoMeta: { ...draft.seoMeta, keywords: lines(event.target.value) } })} rows={3} placeholder="One keyword per line" className={`${inputClassName} resize-y py-3`} />
            </div>
          </div>
          <div className="rounded-2xl border border-slate-700/60 bg-slate-900/50 p-4">
            <h3 className="mb-4 text-sm font-bold uppercase tracking-widest text-slate-300">Onboarding</h3>
            <textarea value={draft.onboardingSteps.join("\n")} onChange={(event) => updateDraft({ onboardingSteps: lines(event.target.value) })} rows={8} placeholder="One onboarding step per line" className={`${inputClassName} resize-y py-3`} />
          </div>
        </section>
      </div>

      {visibleError && (
        <p role="alert" className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {visibleError}
        </p>
      )}

      <div className="flex justify-end border-t border-slate-800 pt-5">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="min-h-12 rounded-xl bg-cyan-500 px-5 text-sm font-bold text-slate-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500"
        >
          {saving ? "Saving course…" : "Save course changes"}
        </button>
      </div>
    </section>
  );
}
