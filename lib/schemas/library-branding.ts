import { z } from "zod";

export const LibraryBrandingSchema = z.object({
  coverImageUrl: z.string().url().nullable(),
}).strict();

export const LibraryCoverUploadRequestSchema = z.object({
  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  size: z.number().int().min(1).max(10 * 1024 * 1024),
}).strict();

export const LibraryCoverUploadResponseSchema = z.object({
  presignedUrl: z.string().url(),
  coverImageUrl: z.string().url(),
  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
}).strict();

export const LibraryBrandingUpdateSchema = z.object({
  coverImageUrl: z.string().url(),
}).strict();

export type LibraryBranding = z.infer<typeof LibraryBrandingSchema>;
