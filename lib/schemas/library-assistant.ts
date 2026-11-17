import { z } from "zod";

export const LibraryChapterOptionSchema = z.object({
  slug: z.string().trim().min(1).max(160),
  bookTitle: z.string().trim().min(1).max(300),
  chapterNumber: z.number().int().positive().max(200),
  chapterTitle: z.string().trim().min(1).max(300),
  chapterIndex: z.number().int().min(0).max(199),
}).strict();

export const LibraryChapterCatalogSchema = z.object({
  chapters: z.array(LibraryChapterOptionSchema).max(10_000),
}).strict();

export const LibraryBookCatalogSchema = z.object({
  books: z.array(z.object({
    slug: z.string().trim().min(1).max(160),
    title: z.string().trim().min(1).max(300),
  }).strict()).max(10_000),
}).strict();

export type LibraryChapterOption = z.infer<typeof LibraryChapterOptionSchema>;
