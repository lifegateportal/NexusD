import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readShortCaptureJob } from "@/lib/short-capture-jobs.mjs";
import { ShortCaptureJobStatusResponseSchema } from "@/lib/schemas/short-capture";

export const runtime = "nodejs";

const JobIdSchema = z.string().uuid();

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  if (!process.env.AUTH_PASSWORD || !process.env.AUTH_COOKIE_SECRET) {
    return NextResponse.json({ error: "Configure Director authentication before checking Shorts capture jobs." }, { status: 503 });
  }

  const { jobId } = await params;
  const parsedJobId = JobIdSchema.safeParse(jobId);
  if (!parsedJobId.success) {
    return NextResponse.json({ error: "Invalid Shorts capture job ID." }, { status: 400 });
  }

  try {
    const job = await readShortCaptureJob(parsedJobId.data);
    if (!job) return NextResponse.json({ error: "Shorts capture job not found." }, { status: 404 });

    const response = ShortCaptureJobStatusResponseSchema.parse({
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      error: job.error ?? null,
      downloadUrl: job.status === "completed"
        ? `/api/ebook/shorts/capture/${job.id}/download`
        : null,
      fileName: `${job.slug}.mp4`,
    });
    return NextResponse.json(response, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("Could not read Shorts capture job:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not read Shorts capture job." },
      { status: 500 },
    );
  }
}
