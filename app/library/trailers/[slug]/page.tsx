import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import LibraryNav from "../../LibraryNav";
import { readPublicTrailer } from "@/lib/trailer-store";
import { TrailerSlugSchema } from "@/lib/schemas/trailer";
import PublishedTrailerPlayer from "../PublishedTrailerPlayer";
import { createEmbeddedTrailerProject } from "@/lib/trailer-utils";

export const runtime = "nodejs";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  if (!TrailerSlugSchema.safeParse(slug).success) return { title: "Trailer | Nexus Library" };
  const trailer = await readPublicTrailer(slug);
  const uploadedVideoUrl = trailer?.sourceType === "upload" ? trailer.videoUrl : undefined;
  return {
    title: trailer ? `${trailer.title} | Nexus Library` : "Trailer | Nexus Library",
    description: trailer ? `Watch ${trailer.title}, a promotional trailer from Nexus Library.` : "A promotional trailer from Nexus Library.",
    ...(trailer && uploadedVideoUrl ? {
      openGraph: {
        title: trailer.title,
        description: `Watch ${trailer.title}, a promotional trailer from Nexus Library.`,
        type: "video.other" as const,
        videos: [{
          url: uploadedVideoUrl,
          secureUrl: uploadedVideoUrl,
          type: uploadedVideoUrl.endsWith(".mp4") ? "video/mp4" : "video/webm",
          width: 720,
          height: Math.round(720 * Number(trailer.aspectRatio.split(":")[1]) / Number(trailer.aspectRatio.split(":")[0])),
        }],
      },
    } : {}),
  };
}

export default async function LibraryTrailerPage({ params }: Props) {
  const { slug } = await params;
  if (!TrailerSlugSchema.safeParse(slug).success) notFound();
  const trailer = await readPublicTrailer(slug);
  if (!trailer) notFound();
  const embeddedProject = trailer.sourceType === "youtube"
    ? createEmbeddedTrailerProject(trailer)
    : null;
  if (trailer.sourceType === "upload" && !trailer.videoUrl) notFound();

  return (
    <div className="min-h-dvh bg-slate-950 text-slate-100 lg:pl-64">
      <LibraryNav />
      <main className="mx-auto min-h-dvh max-w-5xl px-4 pb-24 pt-6 sm:px-6 lg:px-10 lg:pb-10">
        <Link href="/library/trailers" className="inline-flex min-h-12 items-center text-sm font-semibold text-cyan-300">
          ← All trailers
        </Link>
        <article className="mx-auto mt-5 max-w-3xl">
          <header className="mb-5">
            <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-amber-400">Nexus Library · Trailer</p>
            <h1 className="mt-2 text-2xl font-bold tracking-tight text-white sm:text-3xl">{trailer.title}</h1>
          </header>
          {embeddedProject ? (
            <PublishedTrailerPlayer project={embeddedProject} />
          ) : trailer.videoUrl ? (
            <video
              src={trailer.videoUrl}
              controls
              playsInline
              preload="metadata"
              className="mx-auto w-full rounded-xl border border-slate-800 bg-black"
              style={{ aspectRatio: trailer.aspectRatio.replace(":", "/") }}
            >
              Your browser does not support video playback.
            </video>
          ) : null}
        </article>
      </main>
    </div>
  );
}
