import type { Metadata } from "next";
import { notFound } from "next/navigation";
import ShortsPlayer from "@/app/components/ShortsPlayer";
import { readPublicShort } from "@/lib/shorts-store";
import { getShortThumbnailUrl } from "@/lib/short-video-utils";

export const runtime = "nodejs";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug)) {
    return { title: "Video Short Player | Nexus Library", robots: { index: false, follow: false } };
  }
  const project = await readPublicShort(slug);
  if (!project) {
    return { title: "Video Short Player | Nexus Library", robots: { index: false, follow: false } };
  }
  const title = `${project.title} | Nexus Library`;
  const description = project.description || "A transcript-captioned video short from Nexus Library.";
  const thumbnailUrl = getShortThumbnailUrl(project);
  return {
    title,
    description,
    robots: { index: false, follow: false },
    ...(thumbnailUrl ? {
      openGraph: {
        title,
        description,
        type: "website" as const,
        images: [{ url: thumbnailUrl, alt: project.title }],
      },
      twitter: {
        card: "summary_large_image" as const,
        title,
        description,
        images: [thumbnailUrl],
      },
    } : {}),
  };
}

export default async function ShortEmbedPage({ params }: Props) {
  const { slug } = await params;
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug)) notFound();
  const project = await readPublicShort(slug);
  if (!project) notFound();

  return (
    <main className="flex min-h-dvh w-full items-center justify-center overflow-x-hidden bg-black px-2 py-2">
      <ShortsPlayer project={project} embedMode />
    </main>
  );
}
