import { z } from "zod";

export const LibraryCoverImageTypeSchema = z.enum(["image/jpeg", "image/png", "image/webp"]);

export const LibraryBrandingSchema = z.object({
  title: z.string().trim().min(1).max(80).default("Pastor Josh Digital Library"),
  shortName: z.string().trim().min(1).max(16).default("PJDL"),
  tagline: z.string().trim().min(1).max(80).default("Read · Listen · Discover"),
  description: z.string().trim().min(1).max(240).default(
    "Explore books, teaching, and ideas in one place. Find a new read, listen in, or ask questions grounded in the source material.",
  ),
  accentColor: z.enum(["amber", "cyan", "emerald", "rose", "violet"]).default("amber"),
  colorMode: z.enum(["dark", "light"]).default("dark"),
  heroLayout: z.enum(["cinematic", "split", "simple"]).default("cinematic"),
  sections: z.array(z.enum(["newReleases", "myList", "allBooks"]))
    .max(3)
    .default(["newReleases", "myList", "allBooks"])
    .refine((sections) => new Set(sections).size === sections.length, "Library sections must be unique."),
  coverImageUrl: z.string().url().nullable().default(null),
}).strict();

export const LibraryAppearanceUpdateSchema = LibraryBrandingSchema.omit({
  coverImageUrl: true,
}).strict();

export type LibraryBranding = z.infer<typeof LibraryBrandingSchema>;
export type LibraryAppearanceUpdate = z.infer<typeof LibraryAppearanceUpdateSchema>;
