import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import ShortsPlayer from "@/app/components/ShortsPlayer";
import LibraryNav from "../../LibraryNav";
import { readPublicShort } from "@/lib/shorts-store";

export const runtime = "nodejs";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug)) {
    return { title: "Video Short | Nexus Library" };
  }
  const project = await readPublicShort(slug);
  return {
    title: project ? `${project.title} | Nexus Library` : "Video Short | Nexus Library",
    description: project?.description || "A transcript-captioned video short from Nexus Library.",
  };
}

export default async function LibraryShortPage({ params }: Props) {
  const { slug } = await params;
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug)) notFound();
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
            <ShortsPlayer project={project} />
          </div>
          <p className="mt-4 text-center text-xs text-slate-500">
            {project.source.type === "youtube" ? "Playback provided by YouTube." : "Published video source."}
          </p>
        </article>
      </main>
    </div>
  );
}
