import type { ShortProject } from "@/lib/schemas/video-short";

export function getShortThumbnailUrl(
  project: Pick<ShortProject, "source" | "thumbnailUrl">,
): string | undefined {
  if (project.thumbnailUrl) return project.thumbnailUrl;
  return project.source.type === "youtube"
    ? `https://i.ytimg.com/vi/${project.source.videoId}/hqdefault.jpg`
    : undefined;
}
