import { notFound } from "next/navigation";
import ShortCapturePreview from "@/app/ebook/videos/capture/ShortCapturePreview";
import { readShortCaptureJob } from "@/lib/short-capture-jobs.mjs";
import { ShortProjectSchema } from "@/lib/schemas/video-short";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ jobId: string }>;
};

export default async function ShortCapturePage({ params }: Props) {
  if (!process.env.AUTH_PASSWORD || !process.env.AUTH_COOKIE_SECRET) notFound();

  const { jobId } = await params;
  const job = await readShortCaptureJob(jobId);
  if (!job || !["starting", "capturing"].includes(job.status)) notFound();

  let project;
  try {
    project = ShortProjectSchema.parse(JSON.parse(job.projectJson) as unknown);
  } catch (error) {
    console.error("Could not load Shorts capture preview:", error);
    throw new Error("The Shorts capture project could not be loaded.");
  }
  if (project.source.type !== "youtube") notFound();
  return <ShortCapturePreview project={project} />;
}
