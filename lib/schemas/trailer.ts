import { z } from "zod";
import {
  LibraryVideoSegmentSchema,
} from "@/lib/schemas/library-video";
import {
  ShortAspectRatioSchema,
  ShortFrameSlotSchema,
} from "@/lib/schemas/video-short";

export const TrailerSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);

export const TrailerSourceSchema = z.object({
  videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/).optional(),
  youtubeUrl: z.string().url().optional(),
  videoTitle: z.string().trim().max(200).default(""),
  uploadedFileName: z.string().trim().min(1).max(255).optional(),
}).strict().refine(
  (source) => Boolean(source.videoId || source.uploadedFileName),
  { message: "Add a YouTube video or upload an authorized source file." },
).refine(
  (source) => Boolean(source.videoId) === Boolean(source.youtubeUrl),
  { message: "YouTube video ID and URL must be provided together." },
);

export const TrailerMomentSchema = z.object({
  id: z.string().uuid(),
  startSeconds: z.number().finite().min(0),
  endSeconds: z.number().finite().min(0),
  title: z.string().trim().min(1).max(100),
  hook: z.string().trim().max(240).default(""),
  reason: z.string().trim().max(400).default(""),
  frame: z.object({
    fit: z.enum(["cover", "contain"]),
    cropX: z.number().finite().min(0).max(100),
    cropY: z.number().finite().min(0).max(100),
    zoom: z.number().finite().min(1).max(3),
  }).strict().optional(),
  frameSlots: z.array(ShortFrameSlotSchema).min(1).max(100).optional(),
}).strict().superRefine((moment, context) => {
  if (moment.endSeconds <= moment.startSeconds) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["endSeconds"],
      message: "Moment end must be after its start.",
    });
  }
  if (!moment.frameSlots) return;
  const slots = [...moment.frameSlots].sort((first, second) => first.startSeconds - second.startSeconds);
  if (
    Math.abs(slots[0].startSeconds - moment.startSeconds) > 0.05
    || Math.abs(slots[slots.length - 1].endSeconds - moment.endSeconds) > 0.05
    || slots.some((slot, index) =>
      index > 0 && Math.abs(slot.startSeconds - slots[index - 1].endSeconds) > 0.05,
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["frameSlots"],
      message: "Framing slots must cover this trailer moment continuously.",
    });
  }
});

export const TrailerProjectSchema = z.object({
  slug: TrailerSlugSchema,
  title: z.string().trim().min(1).max(120),
  source: TrailerSourceSchema,
  sourceDurationSeconds: z.number().finite().positive().max(3600),
  transcript: z.array(LibraryVideoSegmentSchema).max(20000).default([]),
  moments: z.array(TrailerMomentSchema).min(1).max(24),
  aspectRatio: ShortAspectRatioSchema.default("9:16"),
  fit: z.enum(["cover", "contain"]).default("cover"),
  cropX: z.number().finite().min(0).max(100).default(50),
  cropY: z.number().finite().min(0).max(100).default(50),
  zoom: z.number().finite().min(1).max(3).default(1),
  headline: z.string().trim().max(120).default(""),
  brandLine: z.string().trim().max(80).default(""),
  callToAction: z.string().trim().max(120).default(""),
  updatedAt: z.string().datetime(),
}).strict().refine(
  (project) => project.moments.every(
    (moment) => moment.endSeconds <= project.sourceDurationSeconds,
  ),
  { message: "Trailer moments must stay inside the source video.", path: ["moments"] },
).refine(
  (project) => project.transcript.reduce((size, segment) => size + segment.text.length, 0) <= 1_000_000,
  { message: "The trailer transcript exceeds the storage limit.", path: ["transcript"] },
).refine(
  (project) => project.moments.reduce(
    (duration, moment) => duration + moment.endSeconds - moment.startSeconds,
    0,
  ) <= 300,
  { message: "Keep the assembled trailer at five minutes or less.", path: ["moments"] },
).refine(
  (project) => new Set(project.moments.map((moment) => moment.id)).size === project.moments.length,
  { message: "Trailer moment IDs must be unique.", path: ["moments"] },
);

export const TrailerCatalogSchema = z.object({
  updatedAt: z.string().datetime(),
  trailers: z.array(z.object({
    slug: TrailerSlugSchema,
    title: z.string().trim().min(1).max(120),
    updatedAt: z.string().datetime(),
    status: z.enum(["draft", "published"]).default("draft"),
  }).strict()).max(500),
}).strict();

export const PublishedTrailerSchema = z.object({
  slug: TrailerSlugSchema,
  title: z.string().trim().min(1).max(120),
  videoUrl: z.string().url(),
  aspectRatio: ShortAspectRatioSchema,
  updatedAt: z.string().datetime(),
}).strict();

export const PublicTrailerCatalogSchema = z.object({
  updatedAt: z.string().datetime(),
  trailers: z.array(PublishedTrailerSchema.omit({ videoUrl: true })).max(500),
}).strict();

export const TrailerSuggestionSchema = z.object({
  startSeconds: z.number().finite().min(0),
  endSeconds: z.number().finite().min(0),
  title: z.string().trim().min(1).max(100),
  hook: z.string().trim().min(1).max(240),
  reason: z.string().trim().min(1).max(400),
}).strict().refine((suggestion) => suggestion.endSeconds > suggestion.startSeconds, {
  message: "Suggestion end must be after its start.",
});

export const TrailerSuggestionResponseSchema = z.object({
  suggestions: z.array(TrailerSuggestionSchema).min(1).max(8),
}).strict();

export type TrailerProject = z.infer<typeof TrailerProjectSchema>;
export type TrailerMoment = z.infer<typeof TrailerMomentSchema>;
export type TrailerSuggestion = z.infer<typeof TrailerSuggestionSchema>;
export type PublishedTrailer = z.infer<typeof PublishedTrailerSchema>;
