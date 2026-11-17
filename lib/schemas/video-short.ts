import { z } from "zod";
import { LibraryVideoSegmentSchema } from "@/lib/schemas/library-video";

export const ShortAspectRatioSchema = z.enum(["9:16", "4:5", "1:1", "16:9"]);

export const ShortCropKeyframeSchema = z.object({
  timeSeconds: z.number().finite().min(0),
  x: z.number().finite().min(0).max(100),
  y: z.number().finite().min(0).max(100),
  zoom: z.number().finite().min(1).max(3),
}).strict();

export const ShortFrameSlotSchema = z.object({
  startSeconds: z.number().finite().min(0),
  endSeconds: z.number().finite().min(0),
  aspectRatio: ShortAspectRatioSchema,
  fit: z.enum(["cover", "contain"]),
  keyframes: z.array(ShortCropKeyframeSchema).max(100).default([]),
}).strict().refine((slot) => slot.endSeconds > slot.startSeconds, {
  message: "Frame slot end must be after its start.",
}).refine(
  (slot) => slot.keyframes.every(
    (frame) => frame.timeSeconds >= slot.startSeconds && frame.timeSeconds <= slot.endSeconds,
  ),
  { message: "Crop keyframes must be inside their framing slot.", path: ["keyframes"] },
);

const YouTubeShortSourceSchema = z.object({
  type: z.literal("youtube"),
  videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  videoTitle: z.string().trim().min(1).max(200),
}).strict();

const UploadedShortSourceSchema = z.object({
  type: z.literal("upload"),
  fileName: z.string().trim().min(1).max(255),
  sourceUrl: z.string().url().optional(),
}).strict();

export const ShortSourceSchema = z.discriminatedUnion("type", [
  YouTubeShortSourceSchema,
  UploadedShortSourceSchema,
]);

export const ShortProjectSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).default(""),
  sourceVideoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/).optional(),
  source: ShortSourceSchema,
  startSeconds: z.number().finite().min(0),
  endSeconds: z.number().finite().min(0),
  frameSlots: z.array(ShortFrameSlotSchema).min(1).max(100),
  captions: z.array(LibraryVideoSegmentSchema).max(5000),
  captionsEnabled: z.boolean().default(true),
  captionPosition: z.enum(["top", "middle", "bottom"]).default("bottom"),
  captionSize: z.enum(["small", "medium", "large"]).default("medium"),
  status: z.enum(["draft", "published"]),
  updatedAt: z.string().datetime(),
}).strict().refine((project) => project.endSeconds > project.startSeconds, {
  message: "Short end must be after its start.",
  path: ["endSeconds"],
}).refine(
  (project) => project.frameSlots.every(
    (slot) => slot.startSeconds >= project.startSeconds && slot.endSeconds <= project.endSeconds,
  ),
  { message: "Frame slots must be inside the short's time range.", path: ["frameSlots"] },
).refine((project) => {
  const slots = [...project.frameSlots].sort((a, b) => a.startSeconds - b.startSeconds);
  if (
    Math.abs(slots[0].startSeconds - project.startSeconds) > 0.05
    || Math.abs(slots[slots.length - 1].endSeconds - project.endSeconds) > 0.05
  ) return false;
  return slots.every((slot, index) =>
    index === 0 || Math.abs(slot.startSeconds - slots[index - 1].endSeconds) <= 0.05,
  );
}, {
  message: "Framing slots must cover the short continuously without gaps or overlaps.",
  path: ["frameSlots"],
});

export const PublishedShortProjectSchema = ShortProjectSchema.superRefine((project, context) => {
  if (project.status !== "published") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["status"], message: "Short is not published." });
  }
  if (project.source.type === "upload" && !project.source.sourceUrl) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["source", "sourceUrl"],
      message: "Uploaded shorts need a published source URL.",
    });
  }
});

export const ShortSummarySchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
  title: z.string().trim().min(1).max(120),
  sourceType: z.enum(["youtube", "upload"]),
  videoTitle: z.string().trim().max(200).optional(),
  status: z.enum(["draft", "published"]),
  updatedAt: z.string().datetime(),
}).strict();

export const ShortCatalogSchema = z.object({
  updatedAt: z.string().datetime(),
  shorts: z.array(ShortSummarySchema).max(500),
}).strict();

export const PublicShortCatalogSchema = z.object({
  updatedAt: z.string().datetime(),
  shorts: z.array(ShortSummarySchema.omit({ status: true })).max(500),
}).strict();

export type ShortProject = z.infer<typeof ShortProjectSchema>;
export type ShortFrameSlot = z.infer<typeof ShortFrameSlotSchema>;
export type ShortCropKeyframe = z.infer<typeof ShortCropKeyframeSchema>;
export type ShortSummary = z.infer<typeof ShortSummarySchema>;
