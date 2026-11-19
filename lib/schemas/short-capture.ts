import { z } from "zod";

export const ShortCaptureStatusSchema = z.enum([
  "queued",
  "starting",
  "capturing",
  "uploading",
  "completed",
  "failed",
]);

export const ShortCaptureCreateResponseSchema = z.object({
  jobId: z.string().uuid(),
  status: ShortCaptureStatusSchema,
}).strict();

export const ShortCaptureJobStatusResponseSchema = z.object({
  jobId: z.string().uuid(),
  status: ShortCaptureStatusSchema,
  progress: z.number().finite().min(0).max(1),
  error: z.string().nullable(),
  downloadUrl: z.string()
    .regex(/^\/api\/ebook\/shorts\/capture\/[0-9a-f-]{36}\/download$/)
    .nullable(),
  fileName: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}\.mp4$/),
}).strict();

export type ShortCaptureJobStatusResponse = z.infer<typeof ShortCaptureJobStatusResponseSchema>;
