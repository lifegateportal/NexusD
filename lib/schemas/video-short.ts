import { z } from "zod";
import { LibraryVideoSegmentSchema } from "@/lib/schemas/library-video";

export const ShortAspectRatioSchema = z.enum(["9:16", "4:5", "1:1", "16:9"]);
export const MAX_SHORT_DURATION_SECONDS = 3 * 60;
export const ShortCaptionFontFamilySchema = z.enum(["sans", "condensed", "rounded", "serif"]);
export const ShortCaptionStyleSchema = z.enum(["bold-box", "clean", "outline", "pill", "minimal"]);
export const ShortOverlayPresetStyleSchema = z.enum([
  "headline",
  "lower-third",
  "pill-label",
  "outline-frame",
  "corner-frame",
  "neon-frame",
]);

export const ShortCropKeyframeSchema = z.object({
  timeSeconds: z.number().finite().min(0),
  x: z.number().finite().min(0).max(100),
  y: z.number().finite().min(0).max(100),
  zoom: z.number().finite().min(1).max(3),
  fit: z.enum(["cover", "contain"]).optional(),
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

export const ShortOverlaySchema = z.object({
  id: z.string().uuid(),
  type: z.enum(["text", "image", "frame"]),
  startSeconds: z.number().finite().min(0),
  endSeconds: z.number().finite().min(0),
  left: z.number().finite().min(0).max(100),
  top: z.number().finite().min(0).max(100),
  width: z.number().finite().min(1).max(100),
  height: z.number().finite().min(1).max(100),
  opacity: z.number().finite().min(0).max(1).default(1),
  fontSize: z.number().finite().min(8).max(96).default(32),
  textColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#ffffff"),
  backgroundColor: z.string().regex(/^(#[0-9A-Fa-f]{6}|transparent)$/).default("transparent"),
  textStyle: z.enum(["plain", "headline", "lower-third", "pill"]).default("plain"),
  frameStyle: z.enum(["outline", "corner-brackets", "neon"]).optional(),
  borderColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#22d3ee"),
  borderWidth: z.number().finite().min(0).max(12).default(2),
  borderRadius: z.number().finite().min(0).max(100).default(8),
  zIndex: z.number().int().min(0).max(100).default(60),
  text: z.string().trim().max(300).optional(),
  imageUrl: z.string().url().optional(),
}).strict().superRefine((overlay, context) => {
  if (overlay.endSeconds <= overlay.startSeconds) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["endSeconds"], message: "Overlay end must be after its start." });
  }
  if (overlay.type === "text" && !overlay.text?.trim()) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["text"], message: "Text overlays need text." });
  }
  if (overlay.type === "image" && !overlay.imageUrl) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["imageUrl"], message: "Image overlays need an image." });
  }
  if (overlay.type === "frame" && !overlay.imageUrl && !overlay.frameStyle) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["frameStyle"], message: "Frame overlays need an image or a frame style." });
  }
  if (overlay.left + overlay.width > 100 || overlay.top + overlay.height > 100) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["width"], message: "Overlays must fit inside the frame." });
  }
});

export const ShortBrollClipSchema = z.object({
  id: z.string().uuid(),
  fileName: z.string().trim().min(1).max(255),
  videoUrl: z.string().url(),
  sourceDurationSeconds: z.number().finite().positive().max(3600),
  startSeconds: z.number().finite().min(0),
  endSeconds: z.number().finite().min(0),
  fit: z.enum(["cover", "contain"]).default("cover"),
  provider: z.enum(["upload", "pexels"]).default("upload"),
  providerPageUrl: z.string().url().optional(),
  creatorName: z.string().trim().min(1).max(200).optional(),
  creatorUrl: z.string().url().optional(),
  licenseName: z.string().trim().min(1).max(120).optional(),
  licenseUrl: z.string().url().optional(),
}).strict().superRefine((clip, context) => {
  if (clip.provider === "pexels") {
    for (const field of ["providerPageUrl", "creatorName", "creatorUrl", "licenseName", "licenseUrl"] as const) {
      if (!clip[field]) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: "Pexels B-roll needs creator and license attribution." });
      }
    }
  }
}).refine((clip) => clip.endSeconds > clip.startSeconds, {
  message: "B-roll clip end must be after its start.",
  path: ["endSeconds"],
}).refine((clip) => clip.endSeconds - clip.startSeconds <= clip.sourceDurationSeconds, {
  message: "B-roll timeline duration cannot exceed its uploaded file duration.",
  path: ["endSeconds"],
});

export const ShortMusicTrackSchema = z.object({
  id: z.string().uuid(),
  fileName: z.string().trim().min(1).max(255),
  audioUrl: z.string().url(),
  sourceDurationSeconds: z.number().finite().positive().max(3600),
  startSeconds: z.number().finite().min(0),
  endSeconds: z.number().finite().min(0),
  volume: z.number().finite().min(0).max(1).default(0.25),
  fadeInSeconds: z.number().finite().min(0).max(30).default(1),
  fadeOutSeconds: z.number().finite().min(0).max(30).default(2),
  provider: z.enum(["upload", "jamendo"]).default("upload"),
  providerPageUrl: z.string().url().optional(),
  creatorName: z.string().trim().min(1).max(200).optional(),
  creatorUrl: z.string().url().optional(),
  licenseName: z.string().trim().min(1).max(120).optional(),
  licenseUrl: z.string().url().optional(),
  commercialLicenseConfirmed: z.boolean().default(false),
}).strict().superRefine((track, context) => {
  if (track.provider === "jamendo") {
    for (const field of ["providerPageUrl", "creatorName", "creatorUrl", "licenseName", "licenseUrl"] as const) {
      if (!track[field]) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: "Jamendo music needs creator and license attribution." });
      }
    }
  }
}).refine((track) => track.endSeconds > track.startSeconds, {
  message: "Music track end must be after its start.",
  path: ["endSeconds"],
}).refine((track) => track.endSeconds - track.startSeconds <= track.sourceDurationSeconds, {
  message: "Music timeline duration cannot exceed its uploaded file duration.",
  path: ["endSeconds"],
});

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
  thumbnailUrl: z.string().url().optional(),
  sourceVideoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/).optional(),
  source: ShortSourceSchema,
  startSeconds: z.number().finite().min(0),
  endSeconds: z.number().finite().min(0),
  frameSlots: z.array(ShortFrameSlotSchema).min(1).max(100),
  captions: z.array(LibraryVideoSegmentSchema).max(5000),
  overlays: z.array(ShortOverlaySchema).max(20).default([]),
  brollClips: z.array(ShortBrollClipSchema).max(10).default([]),
  musicTracks: z.array(ShortMusicTrackSchema).max(5).default([]),
  captionsEnabled: z.boolean().default(true),
  captionPosition: z.enum(["top", "middle", "bottom"]).default("bottom"),
  captionSize: z.enum(["small", "medium", "large"]).default("medium"),
  captionFontSize: z.number().finite().min(3.5).max(8).optional(),
  captionFontFamily: ShortCaptionFontFamilySchema.default("sans"),
  captionStyle: ShortCaptionStyleSchema.default("bold-box"),
  captionTextColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#ffffff"),
  captionBackgroundColor: z.string().regex(/^(#[0-9A-Fa-f]{6}|transparent)$/).default("#000000"),
  captionBackgroundOpacity: z.number().finite().min(0).max(1).default(0.78),
  status: z.enum(["draft", "published"]),
  updatedAt: z.string().datetime(),
}).strict().refine((project) => project.endSeconds > project.startSeconds, {
  message: "Short end must be after its start.",
  path: ["endSeconds"],
}).refine((project) => project.endSeconds - project.startSeconds <= MAX_SHORT_DURATION_SECONDS, {
  message: "Shorts can be up to 3 minutes long.",
  path: ["endSeconds"],
}).refine(
  (project) => project.frameSlots.every(
    (slot) => slot.startSeconds >= project.startSeconds && slot.endSeconds <= project.endSeconds,
  ),
  { message: "Frame slots must be inside the short's time range.", path: ["frameSlots"] },
).refine(
  (project) => project.overlays.every(
    (overlay) => overlay.startSeconds >= project.startSeconds && overlay.endSeconds <= project.endSeconds,
  ),
  { message: "Overlays must be inside the short's time range.", path: ["overlays"] },
).refine(
  (project) => project.brollClips.every(
    (clip) => clip.startSeconds >= project.startSeconds && clip.endSeconds <= project.endSeconds,
  ),
  { message: "B-roll clips must be inside the short's time range.", path: ["brollClips"] },
).refine(
  (project) => project.musicTracks.every(
    (track) => track.startSeconds >= project.startSeconds && track.endSeconds <= project.endSeconds,
  ),
  { message: "Music tracks must be inside the short's time range.", path: ["musicTracks"] },
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
  project.musicTracks.forEach((track, index) => {
    if (track.provider === "jamendo" && !track.commercialLicenseConfirmed) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["musicTracks", index, "commercialLicenseConfirmed"],
        message: "Confirm the Jamendo Pro commercial license for each track before publishing.",
      });
    }
  });
});

export const ShortSummarySchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
  title: z.string().trim().min(1).max(120),
  thumbnailUrl: z.string().url().optional(),
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

export const ShortOverlayPresetLayerSchema = z.object({
  style: ShortOverlayPresetStyleSchema,
  text: z.string().trim().max(120).optional(),
  accentColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#22d3ee"),
}).strict().superRefine((layer, context) => {
  if (["headline", "lower-third", "pill-label"].includes(layer.style) && !layer.text?.trim()) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["text"], message: "Text overlay presets need text." });
  }
});

export const ShortOverlayPresetResponseSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(300),
  layers: z.array(ShortOverlayPresetLayerSchema).min(1).max(5),
}).strict();

export const ShortOverlayPresetSchema = ShortOverlayPresetResponseSchema.extend({
  id: z.string().uuid(),
});

export const ShortAgentSettingsSchema = z.object({
  instructions: z.string().trim().max(4000).default(""),
  overlayPresets: z.array(ShortOverlayPresetSchema).max(20).default([]),
}).strict();

export type ShortProject = z.infer<typeof ShortProjectSchema>;
export type ShortFrameSlot = z.infer<typeof ShortFrameSlotSchema>;
export type ShortCropKeyframe = z.infer<typeof ShortCropKeyframeSchema>;
export type ShortOverlay = z.infer<typeof ShortOverlaySchema>;
export type ShortOverlayPreset = z.infer<typeof ShortOverlayPresetSchema>;
export type ShortOverlayPresetLayer = z.infer<typeof ShortOverlayPresetLayerSchema>;
export type ShortSummary = z.infer<typeof ShortSummarySchema>;
export type ShortBrollClip = z.infer<typeof ShortBrollClipSchema>;
export type ShortMusicTrack = z.infer<typeof ShortMusicTrackSchema>;
