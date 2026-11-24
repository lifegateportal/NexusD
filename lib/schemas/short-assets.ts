import { z } from "zod";

export const ShortImageAssetSchema = z.object({
  id: z.string().uuid(),
  fileName: z.string().trim().min(1).max(255),
  imageUrl: z.string().url(),
}).strict();

export const ShortImageLibrarySchema = z.object({
  images: z.array(ShortImageAssetSchema).max(200),
}).strict();

export type ShortImageAsset = z.infer<typeof ShortImageAssetSchema>;
