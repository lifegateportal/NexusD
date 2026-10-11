import { z } from "zod";
import { AcademyPackageSchema } from "@/lib/schemas/academy";
import { SiteConfigSchema } from "@/lib/schemas/site-config";

export const AcademyAccentSchema = z.enum(["cyan", "amber", "emerald", "rose", "violet", "slate"]);

export const PublishedAcademyEntrySchema = z.object({
  slug: z.string(),
  academyName: z.string(),
  tagline: z.string(),
  targetAudience: z.string(),
  publishedAt: z.string(),
  updatedAt: z.string(),
  moduleCount: z.number().int().nonnegative(),
  lessonCount: z.number().int().nonnegative(),
  totalEstimatedHours: z.number().nonnegative(),
  difficultyLevel: z.enum(["beginner", "intermediate", "advanced"]),
  themeVariant: z.enum(["midnight", "amber", "emerald", "rose", "violet", "solar"]),
  accent: AcademyAccentSchema.default("cyan"),
});

export const PublishedAcademyCatalogSchema = z.object({
  updatedAt: z.string(),
  courses: z.array(PublishedAcademyEntrySchema),
});

export const PublishedAcademyManifestSchema = z.object({
  academy: AcademyPackageSchema,
  siteConfig: SiteConfigSchema,
});

export type PublishedAcademyEntry = z.infer<typeof PublishedAcademyEntrySchema>;
export type PublishedAcademyCatalog = z.infer<typeof PublishedAcademyCatalogSchema>;
export type PublishedAcademyManifest = z.infer<typeof PublishedAcademyManifestSchema>;
