import type { TrailerProject } from "@/lib/schemas/trailer";

export function getTrailerMomentFrame(project: TrailerProject, momentIndex: number) {
  const frame = project.moments[momentIndex]?.frame;
  return frame ?? {
    fit: project.fit,
    cropX: project.cropX,
    cropY: project.cropY,
    zoom: project.zoom,
  };
}
