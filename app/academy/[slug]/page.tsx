import { notFound } from "next/navigation";
import { AcademyLandingView } from "@/app/components/AcademyLandingView";
import { PublishedAcademyManifestSchema } from "@/lib/schemas/published-academy";

export const revalidate = 60;

async function fetchManifest(slug: string) {
  const publicUrl = process.env.R2_PUBLIC_URL;
  if (!publicUrl) return null;
  try {
    const response = await fetch(
      `${publicUrl.replace(/\/$/, "")}/academy-published/${encodeURIComponent(slug)}/manifest.json`,
      { next: { revalidate: 60 } },
    );
    if (!response.ok) return null;
    const parsed = PublishedAcademyManifestSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export default async function AcademyLandingPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const manifest = await fetchManifest(slug);
  if (!manifest) notFound();

  return (
    <AcademyLandingView
      initialAcademy={manifest.academy}
      initialSiteConfig={manifest.siteConfig}
      learnHref={`/academy/${slug}/learn`}
      catalogHref="/academy"
    />
  );
}
