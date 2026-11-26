import { z } from "zod";

const DeviceSchema = z.enum(["mobile", "tablet", "desktop"]);

export const LibraryTrafficEventInputSchema = z.object({
  path: z.string().regex(/^\/library(?:\/[^\s?#]*)?$/).max(300),
  sessionId: z.string().uuid(),
  source: z.string().trim().min(1).max(253),
  device: DeviceSchema,
}).strict();

const DailyTrafficSchema = z.object({
  date: z.string(),
  pageViews: z.number().int().nonnegative(),
  sessions: z.number().int().nonnegative(),
});

const TrafficGroupSchema = z.object({
  label: z.string(),
  pageViews: z.number().int().nonnegative(),
});

export const LibraryTrafficSummarySchema = z.object({
  days: z.number().int().positive(),
  pageViews: z.number().int().nonnegative(),
  sessions: z.number().int().nonnegative(),
  byDay: z.array(DailyTrafficSchema),
  topPages: z.array(TrafficGroupSchema),
  topSources: z.array(TrafficGroupSchema),
  devices: z.array(TrafficGroupSchema),
}).strict();

export type LibraryTrafficSummary = z.infer<typeof LibraryTrafficSummarySchema>;
