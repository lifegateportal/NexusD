import type { z } from "zod";

export type ShortCaptureJobStatus =
  | "queued"
  | "starting"
  | "capturing"
  | "uploading"
  | "completed"
  | "failed";

export type ShortCaptureJob = {
  id: string;
  slug: string;
  title: string;
  startSeconds: number;
  endSeconds: number;
  width: number;
  height: number;
  projectJson: string;
  status: ShortCaptureJobStatus;
  progress: number;
  outputKey: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export const ShortCaptureJobSchema: z.ZodType<ShortCaptureJob>;
export function writeShortCaptureJob(job: ShortCaptureJob): Promise<void>;
export function readShortCaptureJob(jobId: string): Promise<ShortCaptureJob | null>;
export function listShortCaptureJobs(): Promise<ShortCaptureJob[]>;
export function writeShortCaptureHeartbeat(): Promise<void>;
export function readShortCaptureHeartbeat(): Promise<{ updatedAt: string } | null>;
