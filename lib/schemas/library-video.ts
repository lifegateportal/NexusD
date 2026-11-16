import { z } from "zod";

export const LibraryVideoSegmentSchema = z.object({
  startSeconds: z.number().finite().min(0),
  endSeconds: z.number().finite().min(0),
  text: z.string().trim().min(1).max(2000),
}).strict();

export const LibraryVideoSchema = z.object({
  videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  title: z.string().trim().min(1).max(200),
  youtubeUrl: z.string().url(),
  addedAt: z.string().datetime(),
}).strict();

export const LibraryVideoCatalogSchema = z.object({
  updatedAt: z.string().datetime(),
  videos: z.array(LibraryVideoSchema).max(500),
}).strict();

export const LibraryVideoRecordSchema = LibraryVideoSchema.extend({
  segments: z.array(LibraryVideoSegmentSchema).min(1).max(20000),
}).strict();

export type LibraryVideo = z.infer<typeof LibraryVideoSchema>;
export type LibraryVideoSegment = z.infer<typeof LibraryVideoSegmentSchema>;
export type LibraryVideoRecord = z.infer<typeof LibraryVideoRecordSchema>;
