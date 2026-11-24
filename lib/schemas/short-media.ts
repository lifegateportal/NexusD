import { z } from "zod";

export const SHORT_MEDIA_SUGGESTION_MAX_CAPTIONS = 2000;
export const SHORT_MEDIA_SUGGESTION_MAX_TRANSCRIPT_CHARACTERS = 40_000;

export const ShortBrollSuggestionSchema = z.object({
  id: z.string().min(1).max(100),
  title: z.string().trim().min(1).max(200),
  query: z.string().trim().min(1).max(120),
  reason: z.string().trim().min(1).max(400),
  videoUrl: z.string().url(),
  previewUrl: z.string().url(),
  durationSeconds: z.number().finite().positive().max(3600),
  startSeconds: z.number().finite().min(0),
  endSeconds: z.number().finite().min(0),
  providerPageUrl: z.string().url(),
  creatorName: z.string().trim().min(1).max(200),
  creatorUrl: z.string().url(),
  licenseName: z.string().trim().min(1).max(120),
  licenseUrl: z.string().url(),
}).strict().refine((suggestion) => suggestion.endSeconds > suggestion.startSeconds, {
  message: "Suggested B-roll end must be after its start.",
  path: ["endSeconds"],
});

export const ShortMusicSuggestionSchema = z.object({
  id: z.string().min(1).max(100),
  title: z.string().trim().min(1).max(200),
  artistName: z.string().trim().min(1).max(200),
  query: z.string().trim().min(1).max(120),
  reason: z.string().trim().min(1).max(400),
  audioUrl: z.string().url(),
  durationSeconds: z.number().finite().positive().max(3600),
  albumImageUrl: z.string().url().optional(),
  providerPageUrl: z.string().url(),
  creatorUrl: z.string().url(),
  licenseName: z.string().trim().min(1).max(120),
  licenseUrl: z.string().url(),
}).strict();

export const ShortBrollSuggestionsResponseSchema = z.object({
  suggestions: z.array(ShortBrollSuggestionSchema).max(12),
}).strict();

export const ShortMusicSuggestionsResponseSchema = z.object({
  suggestions: z.array(ShortMusicSuggestionSchema).max(12),
}).strict();

export type ShortBrollSuggestion = z.infer<typeof ShortBrollSuggestionSchema>;
export type ShortMusicSuggestion = z.infer<typeof ShortMusicSuggestionSchema>;
