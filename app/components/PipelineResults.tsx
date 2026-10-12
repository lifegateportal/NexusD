"use client";

import { useState, useEffect } from "react";
import type { IngestResult, LogicTransformResult } from "@/lib/schemas/blueprint";
import type { UiManifestResult } from "@/lib/schemas/ui-manifest";
import type { AcademyPackage } from "@/lib/schemas/academy";

type StageViewId = "blueprint" | "logic" | "ui" | "academy";

type Props = {
  blueprint: IngestResult;
  logic: LogicTransformResult | null;
  ui: UiManifestResult | null;
  academy: AcademyPackage | null;
  externalStage?: StageViewId;
  onSaveProject?: (name: string) => void | boolean | Promise<void | boolean>;
};

const ASSET_COLORS: Record<string, string> = {
  video:    "border-violet-500/40 text-violet-300",
  audio:    "border-cyan-500/40 text-cyan-300",
  image:    "border-emerald-500/40 text-emerald-300",
  document: "border-amber-500/40 text-amber-300",
  log:      "border-slate-500/40 text-slate-400"
};

const ENTITY_COLORS: Record<string, string> = {
  asset:    "border-violet-500/30 bg-violet-500/10 text-violet-300",
  workflow: "border-cyan-500/30 bg-cyan-500/10 text-cyan-300",
  risk:     "border-red-500/30 bg-red-500/10 text-red-300",
  action:   "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
};

export function PipelineResults({ blueprint, logic, ui, academy, externalStage, onSaveProject }: Props) {
  const [activeStage, setActiveStage] = useState<StageViewId>(externalStage ?? "blueprint");
  const [showSaveBar, setShowSaveBar] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [savedConfirm, setSavedConfirm] = useState(false);

  // Sync tab when the nav sidebar selects a different agent view
  useEffect(() => {
    if (externalStage) setActiveStage(externalStage);
  }, [externalStage]);

  const stageMeta: Record<StageViewId, { label: string; description: string }> = {
    blueprint: {
      label: "Blueprint",
      description: "Confirm the source material, workflow, and risks before continuing.",
    },
    logic: {
      label: "Course plan",
      description: "Review how the source becomes a structured learning experience.",
    },
    ui: {
      label: "Learner experience",
      description: "Review the generated interface direction and interaction model.",
    },
    academy: {
      label: "Academy course",
      description: "Review the finished course package before saving or launching it.",
    },
  };

  async function saveAcademyProject() {
    if (!academy || !onSaveProject || !saveName.trim()) return;
    const saved = await onSaveProject(saveName.trim());
    if (saved === false) return;
    setSavedConfirm(true);
    setShowSaveBar(false);
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-cyan-500/15 glass shadow-panel">
      <div className="flex flex-shrink-0 items-start justify-between gap-4 border-b border-cyan-500/10 px-4 py-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-cyan-500">Academy workspace</p>
          <h2 className="mt-1 text-base font-semibold text-slate-100">{stageMeta[activeStage].label}</h2>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-slate-500">{stageMeta[activeStage].description}</p>
        </div>
        <span className="hidden rounded-full border border-slate-700 bg-slate-900/50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-widest text-slate-500 sm:inline-flex">
          DeepSeek Chat v3
        </span>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto overscroll-contain p-4 text-sm">

        {/* ── Blueprint ── */}
        {activeStage === "blueprint" && (
          <div className="space-y-4">
            <div>
              <h3 className="font-semibold text-slate-100">{blueprint.title}</h3>
              <p className="mt-1 text-slate-400">{blueprint.summary}</p>
            </div>

            {blueprint.assets.length > 0 && (
              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-slate-500">Assets</p>
                <div className="flex flex-wrap gap-1.5">
                  {blueprint.assets.map((a) => (
                    <span
                      key={a.id}
                      className={`rounded-md border px-2 py-0.5 text-[11px] font-medium ${ASSET_COLORS[a.type] ?? ASSET_COLORS.log}`}
                    >
                      {a.title}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {blueprint.workflow.length > 0 && (
              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-slate-500">Workflow</p>
                <ol className="space-y-2">
                  {blueprint.workflow.map((step, i) => (
                    <li key={step.id} className="flex gap-3">
                      <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded bg-slate-800 text-[10px] font-bold text-slate-400">
                        {i + 1}
                      </span>
                      <div>
                        <p className="font-medium text-slate-200">{step.label}</p>
                        <p className="text-xs text-slate-500">{step.intent}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            )}

            {blueprint.riskFlags.length > 0 && (
              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-slate-500">Risk Flags</p>
                {blueprint.riskFlags.map((flag, i) => (
                  <div
                    key={i}
                    className="mb-1.5 flex items-start gap-2 rounded-lg bg-amber-500/5 px-3 py-2 text-xs text-amber-300 ring-1 ring-amber-500/20"
                  >
                    <span className="mt-px">⚠</span>
                    <span>{flag}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Logic Plan ── */}
        {activeStage === "logic" && logic !== null && (
          <div className="space-y-4">
            <p className="text-slate-300">{logic.reasoningSummary}</p>

            {logic.executionPlan.length > 0 && (
              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-slate-500">Execution Plan</p>
                <ol className="space-y-3">
                  {logic.executionPlan.map((s) => (
                    <li key={s.step} className="rounded-xl border border-slate-700/50 bg-slate-900/40 p-3">
                      <div className="mb-1 flex items-center gap-2">
                        <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded bg-accent-500/20 text-[10px] font-bold text-accent-400">
                          {s.step}
                        </span>
                        <span className="font-semibold text-slate-200">{s.title}</span>
                      </div>
                      <p className="mb-1 text-xs text-slate-400">{s.action}</p>
                      <p className="text-xs text-emerald-400/80">→ {s.expectedOutcome}</p>
                    </li>
                  ))}
                </ol>
              </div>
            )}

            {logic.entities.length > 0 && (
              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-slate-500">Entities</p>
                <div className="flex flex-wrap gap-1.5">
                  {logic.entities.map((e) => (
                    <span
                      key={e.id}
                      className={`rounded-md border px-2 py-0.5 text-[11px] font-medium ${ENTITY_COLORS[e.category] ?? ENTITY_COLORS.action}`}
                    >
                      {e.label}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {logic.warnings.length > 0 && (
              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-slate-500">Warnings</p>
                {logic.warnings.map((w, i) => (
                  <div
                    key={i}
                    className="mb-1.5 flex items-start gap-2 rounded-lg bg-amber-500/5 px-3 py-2 text-xs text-amber-300 ring-1 ring-amber-500/20"
                  >
                    <span className="mt-px">⚠</span>
                    <span>{w}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── UI Spec ── */}
        {activeStage === "ui" && ui !== null && (
          <div className="space-y-4">
            <div>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-widest text-slate-500">Visual Direction</p>
              <p className="text-slate-300">{ui.visualDirection}</p>
            </div>

            {ui.components.length > 0 && (
              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-slate-500">Components</p>
                <div className="space-y-2">
                  {ui.components.map((c) => (
                    <div key={c.id} className="rounded-xl border border-slate-700/50 bg-slate-900/40 p-3">
                      <p className="font-semibold text-slate-200">{c.name}</p>
                      <p className="mt-0.5 text-xs text-slate-400">{c.purpose}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {ui.interactions.length > 0 && (
              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-slate-500">Interaction Patterns</p>
                <ul className="space-y-1">
                  {ui.interactions.map((item, i) => (
                    <li key={i} className="flex items-start gap-2 text-xs text-slate-400">
                      <span className="text-accent-400">·</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {ui.accessibilityNotes.length > 0 && (
              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-slate-500">Accessibility</p>
                <ul className="space-y-1">
                  {ui.accessibilityNotes.map((note, i) => (
                    <li key={i} className="flex items-start gap-2 text-xs text-slate-400">
                      <span className="text-emerald-400">✓</span>
                      <span>{note}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* ── Academy ── */}
        {activeStage === "academy" && academy !== null && (
          <div className="space-y-5">
            {/* Header */}
            <div>
              <h3 className="text-lg font-bold text-slate-100">{academy.academyName}</h3>
              <p className="text-sm text-accent-400">{academy.tagline}</p>
              <p className="mt-1 text-xs text-slate-400">{academy.targetAudience}</p>
            </div>

            {/* Landing page */}
            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-slate-500">Landing Page</p>
              <div className="rounded-xl border border-slate-700/50 bg-slate-900/40 p-3 space-y-2">
                <p className="font-bold text-slate-100">{academy.landingPage.headline}</p>
                <p className="text-sm text-slate-300">{academy.landingPage.subheadline}</p>
                <p className="text-xs text-slate-400 italic">{academy.landingPage.problemStatement}</p>
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {academy.landingPage.features.map((f, i) => (
                    <span key={i} className="rounded-md border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-[11px] text-cyan-300">
                      {f.title}
                    </span>
                  ))}
                </div>
                <p className="text-xs font-semibold text-emerald-400">→ {academy.landingPage.cta}</p>
              </div>
            </div>

            {/* Pricing */}
            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-slate-500">Pricing</p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {academy.pricing.map((tier, i) => (
                  <div key={i} className="rounded-xl border border-slate-700/50 bg-slate-900/40 p-3">
                    <p className="font-semibold text-slate-200">{tier.name}</p>
                    <p className="text-lg font-bold text-accent-400">
                      {tier.priceUsd === 0 ? "Free" : `$${tier.priceUsd}`}
                      {tier.priceUsd > 0 && <span className="ml-1 text-xs font-normal text-slate-500">/{tier.period}</span>}
                    </p>
                    <ul className="mt-2 space-y-0.5">
                      {tier.features.map((f, fi) => (
                        <li key={fi} className="flex items-start gap-1 text-[11px] text-slate-400">
                          <span className="text-emerald-500">✓</span>{f}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>

            {/* Curriculum */}
            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-slate-500">Curriculum</p>
              <div className="space-y-2">
                {academy.curriculum.map((mod, mi) => (
                  <div key={mi} className="rounded-xl border border-slate-700/50 bg-slate-900/40 p-3">
                    <p className="font-semibold text-slate-200">{mod.moduleTitle}</p>
                    <p className="mb-2 text-xs text-slate-400">{mod.moduleDescription}</p>
                    <ol className="space-y-1">
                      {mod.lessons.map((lesson, li) => (
                        <li key={li} className="flex items-center gap-2 text-xs">
                          <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded bg-slate-800 text-[9px] font-bold text-slate-400">{li + 1}</span>
                          <span className="flex-1 text-slate-300">{lesson.title}</span>
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                            lesson.type === "video" ? "bg-violet-500/15 text-violet-300" :
                            lesson.type === "quiz" ? "bg-amber-500/15 text-amber-300" :
                            lesson.type === "exercise" ? "bg-orange-500/15 text-orange-300" :
                            "bg-slate-700/50 text-slate-400"
                          }`}>{lesson.type}</span>
                          <span className="text-slate-500">{lesson.durationMinutes}m</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                ))}
              </div>
            </div>

            {/* SEO */}
            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-slate-500">SEO</p>
              <div className="rounded-xl border border-slate-700/50 bg-slate-900/40 p-3 space-y-1">
                <p className="text-sm font-semibold text-slate-200">{academy.seoMeta.title}</p>
                <p className="text-xs text-slate-400">{academy.seoMeta.description}</p>
                <div className="flex flex-wrap gap-1 pt-1">
                  {academy.seoMeta.keywords.map((k, i) => (
                    <span key={i} className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">{k}</span>
                  ))}
                </div>
              </div>
            </div>

            {/* Onboarding */}
            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-slate-500">Onboarding Flow</p>
              <ol className="space-y-1">
                {academy.onboardingSteps.map((step, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs text-slate-300">
                    <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-accent-500/20 text-[9px] font-bold text-accent-400">{i + 1}</span>
                    {step}
                  </li>
                ))}
              </ol>
            </div>

            {/* Launch button */}
            {onSaveProject && (
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => {
                    setSaveName(academy.academyName);
                    setShowSaveBar((current) => !current);
                    setSavedConfirm(false);
                  }}
                  className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-cyan-500/40 bg-cyan-500/10 text-sm font-semibold text-cyan-300 transition hover:bg-cyan-500/20"
                >
                  {savedConfirm ? "✓ Academy project saved" : "Save Academy Project"}
                </button>
                {showSaveBar && (
                  <div className="flex flex-col gap-2 rounded-xl border border-cyan-500/25 bg-slate-900/80 p-3 sm:flex-row">
                    <input
                      autoFocus
                      value={saveName}
                      onChange={(event) => {
                        setSaveName(event.target.value);
                        setSavedConfirm(false);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void saveAcademyProject();
                        if (event.key === "Escape") setShowSaveBar(false);
                      }}
                      placeholder="Academy project name…"
                      className="min-h-12 min-w-0 flex-1 rounded-xl border border-slate-600 bg-slate-800 px-4 text-base text-slate-100 placeholder:text-slate-500 focus:border-cyan-500 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => void saveAcademyProject()}
                      disabled={!saveName.trim()}
                      className="min-h-12 rounded-xl bg-cyan-600 px-5 text-sm font-semibold text-white disabled:opacity-40"
                    >
                      Save
                    </button>
                  </div>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={() => {
                localStorage.setItem("nexus_academy_preview", JSON.stringify(academy));
                window.open("/academy", "_blank");
              }}
              className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-cyan-500 text-sm font-bold text-slate-950 transition hover:bg-cyan-400"
            >
              Launch Academy →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
