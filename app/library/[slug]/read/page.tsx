import { notFound } from "next/navigation";
import { EbookManifestSchema } from "@/lib/schemas/ebook";
import { ReaderClient } from "./ReaderClient";

export const revalidate = 60;

async function fetchManifest(slug: string) {
  const pub = process.env.R2_PUBLIC_URL;
  if (!pub) return null;
  try {
    const res = await fetch(
      `${pub.replace(/\/$/, "")}/published/${slug}/manifest.json`,
      { next: { revalidate: 60 } },
    );
    if (!res.ok) return null;
    const parsed = EbookManifestSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

export default async function ReadPage({
  params,
  searchParams,
}: {
  params:       Promise<{ slug: string }>;
  searchParams: Promise<{ chapter?: string; find?: string }>;
}) {
  const { slug } = await params;
  const search = await searchParams;
  const initial = search.chapter && /^\d+$/.test(search.chapter)
    ? Number(search.chapter)
    : undefined;
  const find = search.find?.trim().slice(0, 300) || undefined;

  const manifest = await fetchManifest(slug);
  if (!manifest) notFound();

  return <ReaderClient manifest={manifest} slug={slug} initialChapter={initial} initialFind={find} />;
}
