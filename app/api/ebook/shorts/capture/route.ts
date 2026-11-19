import { isIP } from "node:net";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import {
  listShortCaptureJobs,
  readShortCaptureHeartbeat,
  writeShortCaptureJob,
} from "@/lib/short-capture-jobs.mjs";
import { ShortProjectSchema } from "@/lib/schemas/video-short";
import {
  ShortCaptureJobStatusResponseSchema,
} from "@/lib/schemas/short-capture";

export const runtime = "nodejs";

const RequestSchema = z.object({ project: ShortProjectSchema }).strict();
const SlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
const MAX_ACTIVE_JOBS = 3;
const WORKER_HEARTBEAT_MAX_AGE_MS = 30_000;

function authConfigured(): boolean {
  return Boolean(process.env.AUTH_PASSWORD && process.env.AUTH_COOKIE_SECRET);
}

function isPublicHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    return url.protocol === "https:"
      && isIP(hostname) === 0
      && hostname !== "localhost"
      && !hostname.endsWith(".localhost")
      && !hostname.endsWith(".local")
      && !hostname.endsWith(".internal");
  } catch {
    return false;
  }
}

export async function GET(request: NextRequest) {
  if (!authConfigured()) {
    return NextResponse.json({ error: "Configure Director authentication before checking Shorts captures." }, { status: 503 });
  }
  if (!env.SHORT_CAPTURE_JOB_DIR) {
    return NextResponse.json({ error: "Configure SHORT_CAPTURE_JOB_DIR for the capture worker." }, { status: 503 });
  }
  const parsedSlug = SlugSchema.safeParse(request.nextUrl.searchParams.get("slug"));
  if (!parsedSlug.success) {
    return NextResponse.json({ error: "Enter a valid Shorts project slug." }, { status: 400 });
  }

  try {
    const jobs = await listShortCaptureJobs();
    const latestJob = jobs
      .filter((job) => job.slug === parsedSlug.data)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    const job = latestJob
      ? ShortCaptureJobStatusResponseSchema.parse({
        jobId: latestJob.id,
        status: latestJob.status,
        progress: latestJob.progress,
        error: latestJob.error ?? null,
        downloadUrl: latestJob.status === "completed"
          ? `/api/ebook/shorts/capture/${latestJob.id}/download`
          : null,
        fileName: `${latestJob.slug}.mp4`,
      })
      : null;
    return NextResponse.json({ job }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("Could not load Shorts capture history:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not load Shorts capture history." },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  if (!authConfigured()) {
    return NextResponse.json({ error: "Configure Director authentication before capturing Shorts." }, { status: 503 });
  }
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.SHORT_CAPTURE_R2_BUCKET) {
    return NextResponse.json({ error: "Configure a private Shorts capture R2 bucket before capturing." }, { status: 503 });
  }
  if (!env.SHORT_CAPTURE_JOB_DIR) {
    return NextResponse.json({ error: "Configure SHORT_CAPTURE_JOB_DIR for the capture worker." }, { status: 503 });
  }

  let project: z.infer<typeof ShortProjectSchema>;
  try {
    project = RequestSchema.parse(await request.json() as unknown).project;
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid Shorts capture request." },
      { status: 400 },
    );
  }

  if (project.source.type !== "youtube") {
    return NextResponse.json({ error: "Server capture is only available for YouTube preview projects." }, { status: 400 });
  }
  if (project.sourceVideoId && project.sourceVideoId !== project.source.videoId) {
    return NextResponse.json({ error: "The Shorts project video ID does not match its YouTube source." }, { status: 400 });
  }
  const mediaUrls = [
    project.thumbnailUrl,
    ...project.overlays.map((overlay) => overlay.imageUrl),
    ...project.brollClips.map((clip) => clip.videoUrl),
    ...project.musicTracks.map((track) => track.audioUrl),
  ].filter((url): url is string => Boolean(url));
  if (mediaUrls.some((url) => !isPublicHttpsUrl(url))) {
    return NextResponse.json({ error: "Capture layers must use public HTTPS media URLs." }, { status: 400 });
  }
  const projectJson = JSON.stringify(project);
  if (projectJson.length > 5_000_000) {
    return NextResponse.json({ error: "The Shorts project is too large to capture." }, { status: 413 });
  }

  try {
    const heartbeat = await readShortCaptureHeartbeat();
    if (!heartbeat || Date.now() - Date.parse(heartbeat.updatedAt) > WORKER_HEARTBEAT_MAX_AGE_MS) {
      return NextResponse.json({ error: "The Shorts capture worker is offline. Start it on the configured host and retry." }, { status: 503 });
    }

    const jobs = await listShortCaptureJobs();
    const activeCount = jobs.filter((job) =>
      ["queued", "starting", "capturing", "uploading"].includes(job.status),
    ).length;
    if (activeCount >= MAX_ACTIVE_JOBS) {
      return NextResponse.json({ error: "The Shorts capture queue is full. Wait for a job to finish and retry." }, { status: 429 });
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const [aspectWidth, aspectHeight] = project.frameSlots[0].aspectRatio.split(":").map(Number);
    const aspectRatio = aspectWidth / aspectHeight;
    const width = aspectRatio >= 1 ? 1280 : 720;
    const job = {
      id,
      slug: project.slug,
      title: project.title,
      startSeconds: project.startSeconds,
      endSeconds: project.endSeconds,
      width,
      height: Math.round(width / aspectRatio),
      projectJson,
      status: "queued" as const,
      progress: 0,
      outputKey: `director/shorts/capture-exports/${id}.mp4`,
      createdAt: now,
      updatedAt: now,
    };
    await writeShortCaptureJob(job);
    return NextResponse.json({ jobId: id, status: job.status }, {
      status: 202,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    console.error("Could not queue Shorts capture:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not queue Shorts capture." },
      { status: 500 },
    );
  }
}
