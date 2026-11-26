import { z } from "zod";

export const LibraryCoverImageTypeSchema = z.enum(["image/jpeg", "image/png", "image/webp"]);
export const LibrarySectionSchema = z.enum([
  "featuredSermons",
  "featuredShorts",
  "featuredBooks",
  "newReleases",
  "myList",
  "allBooks",
]);

export const LibraryBrandingSchema = z.object({
  title: z.string().trim().min(1).max(80).default("Pastor Josh Digital Library"),
  shortName: z.string().trim().min(1).max(16).default("PJDL"),
  tagline: z.string().trim().min(1).max(80).default("Read · Listen · Discover"),
  description: z.string().trim().min(1).max(240).default(
    "Explore books, teaching, and ideas in one place. Find a new read, listen in, or ask questions grounded in the source material.",
  ),
  accentColor: z.enum(["amber", "cyan", "emerald", "rose", "violet"]).default("amber"),
  colorMode: z.enum(["dark", "light"]).default("dark"),
  askLibraryEnabled: z.boolean().default(true),
  heroLayout: z.enum(["cinematic", "split", "simple"]).default("cinematic"),
  simpleCoverLayer: z.enum(["behind", "foreground"]).default("behind"),
  featuredSermonIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{11}$/))
    .max(8)
    .default([])
    .refine((ids) => new Set(ids).size === ids.length, "Featured sermon videos must be unique."),
  featuredShortSlugs: z.array(z.string().trim().min(1).max(100))
    .max(8)
    .default([])
    .refine((slugs) => new Set(slugs).size === slugs.length, "Featured shorts must be unique."),
  featuredBookSlugs: z.array(z.string().trim().min(1).max(100))
    .max(8)
    .default([])
    .refine((slugs) => new Set(slugs).size === slugs.length, "Featured books must be unique."),
  sections: z.array(LibrarySectionSchema)
    .max(6)
    .default(["featuredSermons", "featuredShorts", "featuredBooks", "newReleases", "myList", "allBooks"])
    .refine((sections) => new Set(sections).size === sections.length, "Library sections must be unique."),
  coverImageUrl: z.string().url().nullable().default(null),
}).strict();

export const LibraryAppearanceUpdateSchema = LibraryBrandingSchema.omit({
  coverImageUrl: true,
}).strict();

export type LibraryBranding = z.infer<typeof LibraryBrandingSchema>;
export type LibraryAppearanceUpdate = z.infer<typeof LibraryAppearanceUpdateSchema>;
