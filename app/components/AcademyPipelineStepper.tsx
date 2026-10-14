"use client";

import type { PipelineStage } from "@/lib/types";

export type AcademyStepId = "overview" | "brief" | "outline" | "review" | "deploy";

type Props = {
  activeStep: AcademyStepId | null;
  pipelineStage: PipelineStage;
  hasBlueprint: boolean;
  hasBuildBrief: boolean;
  hasCoursePlan: boolean;
  hasAcademy: boolean;
  hasPublishedCourse?: boolean;
  onSelect: (step: AcademyStepId) => void;
};

const STEPS: Array<{ id: AcademyStepId; label: string; description: string }> = [
  { id: "overview", label: "Source", description: "Add material" },
  { id: "brief", label: "Define", description: "Choose the build" },
  { id: "outline", label: "Outline", description: "Shape the course" },
  { id: "review", label: "Review", description: "Edit the content" },
  { id: "deploy", label: "Deploy", description: "Publish to Academy" },
];

function isRunning(stage: PipelineStage) {
  return stage === "ingesting"
    || stage === "reasoning"
    || stage === "generating"
    || stage === "producing";
}

export function AcademyPipelineStepper({
  activeStep,
  pipelineStage,
  hasBlueprint,
  hasBuildBrief,
  hasCoursePlan,
  hasAcademy,
  hasPublishedCourse = false,
  onSelect,
}: Props) {
  const readyByStep: Record<AcademyStepId, boolean> = {
    overview: true,
    brief: hasBlueprint,
    outline: hasBuildBrief,
    review: hasCoursePlan,
    deploy: hasAcademy,
  };
  const completedByStep: Record<AcademyStepId, boolean> = {
    overview: hasBlueprint,
    brief: hasBuildBrief,
    outline: hasCoursePlan,
    review: hasAcademy && pipelineStage === "done",
    deploy: hasPublishedCourse,
  };

  return (
    <nav
      aria-label="Academy pipeline stages"
      className="flex flex-shrink-0 gap-2 overflow-x-auto border-b border-cyan-500/10 px-3 py-3 glass-light lg:gap-3 lg:px-5"
    >
      {STEPS.map((step, index) => {
        const ready = readyByStep[step.id];
        const active = activeStep === step.id;
        const completed = completedByStep[step.id];
        const running = active && isRunning(pipelineStage);
        return (
          <button
            key={step.id}
            type="button"
            disabled={!ready}
            onClick={() => ready && onSelect(step.id)}
            aria-current={active ? "step" : undefined}
            className={[
              "flex min-h-12 min-w-[116px] flex-1 items-center gap-2 rounded-xl border px-3 text-left transition-colors lg:min-w-0",
              active
                ? "border-cyan-400/50 bg-cyan-500/10 text-cyan-200"
                : ready
                  ? "border-slate-700/70 bg-slate-900/40 text-slate-300"
                  : "cursor-not-allowed border-slate-800/60 bg-slate-950/30 text-slate-700",
            ].join(" ")}
          >
            <span
              className={[
                "flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold",
                running
                  ? "animate-pulse bg-cyan-400 text-slate-950"
                  : completed
                    ? "bg-emerald-500/20 text-emerald-300"
                    : active
                      ? "bg-cyan-500/20 text-cyan-300"
                      : "bg-slate-800 text-slate-500",
              ].join(" ")}
            >
              {completed ? "✓" : index + 1}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-xs font-semibold">{step.label}</span>
              <span className="block truncate text-[10px] text-slate-500">{step.description}</span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}
