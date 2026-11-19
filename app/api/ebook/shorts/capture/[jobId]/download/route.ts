import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { readShortCaptureJob } from "@/lib/short-capture-jobs.mjs";
import { makeR2Client } from "@/lib/r2-storage";

export const runtime = "nodejs";

const JobIdSchema = z.string().uuid();

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  if (!process.env.AUTH_PASSWORD || !process.env.AUTH_COOKIE_SECRET) {
    return NextResponse.json({ error: "Configure Director authentication before downloading Shorts captures." }, { status: 503 });
  }

  const { jobId } = await params;
  const parsedJobId = JobIdSchema.safeParse(jobId);
  if (!parsedJobId.success) {
    return NextResponse.json({ error: "Invalid Shorts capture job ID." }, { status: 400 });
  }

  try {
    const job = await readShortCaptureJob(parsedJobId.data);
    if (!job) return NextResponse.json({ error: "Shorts capture job not found." }, { status: 404 });
    if (job.status !== "completed") {
      return NextResponse.json({ error: "This Shorts capture is not ready to download." }, { status: 409 });
    }
    if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.SHORT_CAPTURE_R2_BUCKET) {
      return NextResponse.json({ error: "Configure the private Shorts capture R2 bucket before downloading." }, { status: 503 });
    }

    const signedUrl = await getSignedUrl(makeR2Client(), new GetObjectCommand({
      Bucket: env.SHORT_CAPTURE_R2_BUCKET,
      Key: job.outputKey,
      ResponseContentType: "video/mp4",
      ResponseContentDisposition: `attachment; filename="${job.slug}.mp4"`,
    }), { expiresIn: 60 * 60 });
    return NextResponse.redirect(signedUrl, 307);
  } catch (error) {
    console.error("Could not prepare Shorts capture download:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not prepare Shorts capture download." },
      { status: 500 },
    );
  }
}
