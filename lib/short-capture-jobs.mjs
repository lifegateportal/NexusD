import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";

const JobIdSchema = z.string().uuid();
const JobDirectory = () => {
  const configured = process.env.SHORT_CAPTURE_JOB_DIR?.trim();
  if (!configured) throw new Error("Set SHORT_CAPTURE_JOB_DIR for the Shorts capture worker.");
  return resolve(configured);
};

const JobStatusSchema = z.enum(["queued", "starting", "capturing", "uploading", "completed", "failed"]);

export const ShortCaptureJobSchema = z.object({
  id: JobIdSchema,
  slug: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
  title: z.string().trim().min(1).max(120),
  startSeconds: z.number().finite().min(0),
  endSeconds: z.number().finite().min(0),
  width: z.number().int().min(320).max(1280),
  height: z.number().int().min(320).max(1280),
  projectJson: z.string().min(2).max(5_000_000),
  status: JobStatusSchema,
  progress: z.number().finite().min(0).max(1),
  outputKey: z.string().regex(/^director\/shorts\/capture-exports\/[0-9a-f-]{36}\.mp4$/),
  error: z.string().trim().max(500).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict().superRefine((job, context) => {
  if (job.endSeconds <= job.startSeconds) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["endSeconds"], message: "Capture end must be after its start." });
  }
  if (job.outputKey !== `director/shorts/capture-exports/${job.id}.mp4`) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["outputKey"], message: "Capture output key must match its job ID." });
  }
});

const HeartbeatSchema = z.object({
  updatedAt: z.string().datetime(),
}).strict();

async function writeAtomic(filePath, data) {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, data, { mode: 0o600 });
  await rename(temporaryPath, filePath);
}

function jobPath(jobId) {
  return join(JobDirectory(), `${JobIdSchema.parse(jobId)}.json`);
}

export async function writeShortCaptureJob(input) {
  const job = ShortCaptureJobSchema.parse(input);
  const directory = JobDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeAtomic(join(directory, `${job.id}.json`), JSON.stringify(job));
}

export async function readShortCaptureJob(jobId) {
  let contents;
  try {
    contents = await readFile(jobPath(jobId), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  return ShortCaptureJobSchema.parse(JSON.parse(contents));
}

export async function listShortCaptureJobs() {
  const directory = JobDirectory();
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const jobs = await Promise.all(entries
    .filter((entry) => entry.isFile() && /^[0-9a-f-]{36}\.json$/.test(entry.name))
    .map(async (entry) => {
      const contents = await readFile(join(directory, entry.name), "utf8");
      return ShortCaptureJobSchema.parse(JSON.parse(contents));
    }));
  return jobs.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function writeShortCaptureHeartbeat() {
  const directory = JobDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const heartbeat = HeartbeatSchema.parse({ updatedAt: new Date().toISOString() });
  await writeAtomic(join(directory, "worker-heartbeat.json"), JSON.stringify(heartbeat));
}

export async function readShortCaptureHeartbeat() {
  let contents;
  try {
    contents = await readFile(join(JobDirectory(), "worker-heartbeat.json"), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  return HeartbeatSchema.parse(JSON.parse(contents));
}
