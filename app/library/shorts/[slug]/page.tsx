import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import ShortsPlayer from "@/app/components/ShortsPlayer";
import LibraryNav from "../../LibraryNav";
import { readPublicShort } from "@/lib/shorts-store";
import { getShortThumbnailUrl } from "@/lib/short-video-utils";
import { ShortSlugSchema } from "@/lib/schemas/video-short";

export const runtime = "nodejs";

type Props = { params: Promise<{ slug: string }> };

async function getRequestOrigin(): Promise<string | undefined> {
  const requestHeaders = await headers();
  const host = (requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host"))
    ?.split(",")[0]
    ?.trim();
  const protocol = (requestHeaders.get("x-forwarded-proto") ?? "https")
    .split(",")[0]
    .trim();
  const port = host?.match(/:(\d+)$/)?.[1];
  if (
    !host
    || !/^[a-z0-9.-]+(?::\d{1,5})?$/i.test(host)
    || (port !== undefined && Number(port) > 65535)
    || !["http", "https"].includes(protocol)
  ) {
    return undefined;
  }
  return `${protocol}://${host}`;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  if (!ShortSlugSchema.safeParse(slug).success) {
    return { title: "Video Short | Nexus Library" };
  }
  const project = await readPublicShort(slug);
  const title = project ? `${project.title} | Nexus Library` : "Video Short | Nexus Library";
  const description = project?.description || "A transcript-captioned video short from Nexus Library.";
  const thumbnailUrl = project ? getShortThumbnailUrl(project) : undefined;
  const requestOrigin = project ? await getRequestOrigin() : undefined;
  const playerUrl = project && requestOrigin
    ? new URL(`/library/shorts/${encodeURIComponent(project.slug)}/embed`, requestOrigin).toString()
    : undefined;
  const [aspectWidth, aspectHeight] = (project?.frameSlots[0]?.aspectRatio ?? "9:16")
    .split(":")
    .map(Number);
  const videoWidth = 720;
  const videoHeight = Math.round(videoWidth * aspectHeight / aspectWidth);
  return {
    title,
    description,
    ...(project ? {
      openGraph: {
        title,
        description,
        type: playerUrl ? "video.other" as const : "website" as const,
        ...(playerUrl ? {
          videos: [{
            url: playerUrl,
            secureUrl: playerUrl,
            type: "text/html",
            width: videoWidth,
            height: videoHeight,
          }],
        } : {}),
        ...(thumbnailUrl ? { images: [{ url: thumbnailUrl, alt: project.title }] } : {}),
      },
      twitter: {
        card: thumbnailUrl ? "summary_large_image" as const : "summary" as const,
        title,
        description,
        ...(thumbnailUrl ? { images: [thumbnailUrl] } : {}),
      },
    } : {}),
  };
}

export default async function LibraryShortPage({ params }: Props) {
  const { slug } = await params;
  if (!ShortSlugSchema.safeParse(slug).success) notFound();
  const project = await readPublicShort(slug);
  if (!project) notFound();

  return (
    <div className="min-h-dvh bg-slate-950 text-slate-100 lg:pl-64">
      <LibraryNav />
      <main className="mx-auto min-h-dvh max-w-5xl px-4 pb-24 pt-6 sm:px-6 lg:px-10 lg:pb-10">
        <Link href="/library/shorts" className="inline-flex min-h-12 items-center text-sm font-semibold text-cyan-300">
          ← All shorts
        </Link>
        <article className="mx-auto mt-5 max-w-3xl">
          <header className="mb-5">
            <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-amber-400">Nexus Library · Short</p>
            <h1 className="mt-2 text-2xl font-bold tracking-tight text-white sm:text-3xl">{project.title}</h1>
            {project.description && <p className="mt-2 text-sm leading-relaxed text-slate-300">{project.description}</p>}
          </header>
          <div className="mx-auto w-full max-w-md">
            <ShortsPlayer project={project} showErrors={false} />
          </div>
          <p className="mt-4 text-center text-xs text-slate-500">
            {project.source.type === "youtube" ? "Playback provided by YouTube." : "Published video source."}
          </p>
        </article>
      </main>
    </div>
  );
}
