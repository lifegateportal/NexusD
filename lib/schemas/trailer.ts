import { z } from "zod";
import {
  LibraryVideoSegmentSchema,
} from "@/lib/schemas/library-video";
import {
  ShortAspectRatioSchema,
  ShortFrameSlotSchema,
} from "@/lib/schemas/video-short";

export const TrailerSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
export const TrailerTransitionSchema = z.enum([
  "cut",
  "fade",
  "slide-left",
  "slide-right",
  "slide-up",
  "slide-down",
  "zoom-in",
  "zoom-out",
]);

export const TrailerMusicTrackSchema = z.object({
  id: z.string().uuid(),
  fileName: z.string().trim().min(1).max(255),
  audioUrl: z.string().url(),
  sourceDurationSeconds: z.number().finite().positive().max(3600),
  startSeconds: z.number().finite().min(0).max(300),
  endSeconds: z.number().finite().min(0).max(300),
  volume: z.number().finite().min(0).max(1).default(0.25),
  fadeInSeconds: z.number().finite().min(0).max(30).default(1),
  fadeOutSeconds: z.number().finite().min(0).max(30).default(2),
  duckUnderSpeech: z.boolean().default(true),
  duckVolume: z.number().finite().min(0).max(1).default(0.15),
  loop: z.boolean().default(true),
  provider: z.literal("jamendo"),
  providerPageUrl: z.string().url(),
  creatorName: z.string().trim().min(1).max(200),
  creatorUrl: z.string().url(),
  licenseName: z.string().trim().min(1).max(120),
  licenseUrl: z.string().url(),
  commercialLicenseConfirmed: z.boolean().default(false),
}).strict().refine((track) => track.endSeconds > track.startSeconds, {
  message: "Music track end must be after its start.",
  path: ["endSeconds"],
});

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
  transitionIn: TrailerTransitionSchema.default("cut"),
  transitionOut: TrailerTransitionSchema.default("cut"),
  transitionDurationSeconds: z.number().finite().min(0).max(3).default(0.5),
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
  musicTracks: z.array(TrailerMusicTrackSchema).max(5).default([]),
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
  (project) => {
    const assembledDuration = project.moments.reduce(
      (duration, moment) => duration + moment.endSeconds - moment.startSeconds,
      0,
    );
    return project.musicTracks.every((track) => track.endSeconds <= assembledDuration);
  },
  { message: "Music tracks must stay inside the assembled trailer timeline.", path: ["musicTracks"] },
).refine(
  (project) => new Set(project.moments.map((moment) => moment.id)).size === project.moments.length,
  { message: "Trailer moment IDs must be unique.", path: ["moments"] },
);

export const TrailerPublishRequestSchema = z.object({
  slug: TrailerSlugSchema,
  title: z.string().trim().min(1).max(120),
  sourceType: z.enum(["youtube", "upload"]).default("upload"),
  videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/).optional(),
  videoTitle: z.string().trim().max(200).default(""),
  videoUrl: z.string().url().optional(),
  aspectRatio: ShortAspectRatioSchema,
  moments: z.array(TrailerMomentSchema).max(24).default([]),
  musicTracks: z.array(TrailerMusicTrackSchema).max(5).default([]),
  headline: z.string().trim().max(120).default(""),
  brandLine: z.string().trim().max(80).default(""),
  callToAction: z.string().trim().max(120).default(""),
}).strict();

const PublishedTrailerFieldsSchema = TrailerPublishRequestSchema.extend({
  updatedAt: z.string().datetime(),
});

export const PublishedTrailerSchema = PublishedTrailerFieldsSchema.superRefine((trailer, context) => {
  if (trailer.sourceType === "youtube") {
    if (!trailer.videoId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["videoId"], message: "YouTube trailers need a source video ID." });
    }
    if (trailer.moments.length === 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["moments"], message: "YouTube trailers need at least one published moment." });
    }
  } else if (!trailer.videoUrl) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["videoUrl"], message: "Rendered trailers need a published video file." });
  }
  trailer.musicTracks.forEach((track, index) => {
    if (!track.commercialLicenseConfirmed) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["musicTracks", index, "commercialLicenseConfirmed"],
        message: "Confirm the commercial license for each published soundtrack.",
      });
    }
  });
});

export const TrailerCatalogSchema = z.object({
  updatedAt: z.string().datetime(),
  trailers: z.array(z.object({
    slug: TrailerSlugSchema,
    title: z.string().trim().min(1).max(120),
    updatedAt: z.string().datetime(),
    status: z.enum(["draft", "published"]).default("draft"),
  }).strict()).max(500),
}).strict();

export const PublicTrailerCatalogSchema = z.object({
  updatedAt: z.string().datetime(),
  trailers: z.array(z.object({
    slug: TrailerSlugSchema,
    title: z.string().trim().min(1).max(120),
    sourceType: z.enum(["youtube", "upload"]).default("upload"),
    aspectRatio: ShortAspectRatioSchema,
    updatedAt: z.string().datetime(),
  }).strict()).max(500),
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
export type TrailerMusicTrack = z.infer<typeof TrailerMusicTrackSchema>;
export type TrailerSuggestion = z.infer<typeof TrailerSuggestionSchema>;
export type PublishedTrailer = z.infer<typeof PublishedTrailerSchema>;
