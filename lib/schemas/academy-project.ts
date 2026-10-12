import { z } from "zod";
import { AcademyPackageSchema } from "@/lib/schemas/academy";
import { IngestResultSchema, LogicTransformResultSchema } from "@/lib/schemas/blueprint";
import { UiManifestResultSchema } from "@/lib/schemas/ui-manifest";
import { SiteConfigSchema } from "@/lib/schemas/site-config";

export const AcademyChatMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
}).strict();

export const AcademyProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  folderId: z.string().optional(),
  academy: AcademyPackageSchema,
  siteConfig: SiteConfigSchema,
  deliveryInstructions: z.string(),
  chatHistory: z.array(AcademyChatMessageSchema),
  blueprint: IngestResultSchema.nullable(),
  logicResult: LogicTransformResultSchema.nullable(),
  uiResult: UiManifestResultSchema.nullable(),
  academyPublishedSlug: z.string().regex(/^[a-z0-9-]+$/).optional(),
}).strict();

export type AcademyProjectRecord = z.infer<typeof AcademyProjectSchema>;
