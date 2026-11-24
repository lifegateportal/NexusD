import {
  ShortProjectSchema,
  type ShortProject,
} from "@/lib/schemas/video-short";
import type { LibraryVideoSegment } from "@/lib/schemas/library-video";

export function createShortSlug(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 52) || "video-short";
}

export function createUploadedShortProject(
  fileName: string,
  durationSeconds: number,
  segments: LibraryVideoSegment[],
): ShortProject {
  const baseTitle = fileName.replace(/\.[^.]+$/, "").trim().slice(0, 120) || "Uploaded video";
  const startSeconds = Math.min(segments[0]?.startSeconds ?? 0, Math.max(0, durationSeconds - 0.1));
  const endSeconds = Math.min(durationSeconds, startSeconds + 60);
  const sourceTranscript = segments.slice(0, 20000);
  const captions = sourceTranscript.flatMap((segment) => {
    if (segment.endSeconds <= startSeconds || segment.startSeconds >= endSeconds) return [];
    return [{
      ...segment,
      startSeconds: Math.max(startSeconds, segment.startSeconds),
      endSeconds: Math.min(endSeconds, segment.endSeconds),
    }];
  }).slice(0, 5000);
  return ShortProjectSchema.parse({
    slug: `${createShortSlug(baseTitle)}-${crypto.randomUUID().slice(0, 8)}`,
    title: `${baseTitle} Short`.slice(0, 120),
    description: "",
    source: { type: "upload", fileName },
    sourceDurationSeconds: durationSeconds,
    sourceTranscript,
    startSeconds,
    endSeconds,
    frameSlots: [{
      startSeconds,
      endSeconds,
      aspectRatio: "9:16",
      fit: "cover",
      keyframes: [{ timeSeconds: startSeconds, x: 50, y: 50, zoom: 1, fit: "cover" }],
    }],
    captions,
    overlays: [],
    captionsEnabled: true,
    captionPosition: "bottom",
    captionSize: "medium",
    captionFontSize: 5.2,
    captionFontFamily: "sans",
    captionStyle: "bold-box",
    captionTextColor: "#ffffff",
    captionBackgroundColor: "#000000",
    captionBackgroundOpacity: 0.78,
    status: "draft",
    updatedAt: new Date().toISOString(),
  });
}

export function getShortThumbnailUrl(
  project: Pick<ShortProject, "source" | "thumbnailUrl">,
): string | undefined {
  if (project.thumbnailUrl) return project.thumbnailUrl;
  return project.source.type === "youtube"
    ? `https://i.ytimg.com/vi/${project.source.videoId}/hqdefault.jpg`
    : undefined;
}
