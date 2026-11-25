import { env } from "@/lib/env";
import {
  LibraryVideoCatalogSchema,
  type LibraryVideo,
} from "@/lib/schemas/library-video";
import {
  PublicShortCatalogSchema,
} from "@/lib/schemas/video-short";
import {
  PublishedCatalogSchema,
  type PublishedBookEntry,
} from "@/lib/schemas/published-book";
import { z } from "zod";

async function fetchPublicCatalog<T>(
  key: string,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  emptyCatalog: T,
): Promise<T> {
  if (!env.R2_PUBLIC_URL) return emptyCatalog;
  const response = await fetch(`${env.R2_PUBLIC_URL.replace(/\/$/, "")}/${key}`, {
    next: { revalidate: 60 },
  });
  if (response.status === 404) return emptyCatalog;
  if (!response.ok) throw new Error(`Could not load PJDL welcome content (${response.status}).`);
  const parsed = schema.safeParse(await response.json() as unknown);
  if (!parsed.success) throw new Error("The PJDL welcome content catalog is invalid.");
  return parsed.data;
}

export async function readLibraryWelcomeContent(): Promise<{
  books: PublishedBookEntry[];
  sermons: LibraryVideo[];
  shorts: z.infer<typeof PublicShortCatalogSchema>["shorts"];
}> {
  const [books, videos, shorts] = await Promise.all([
    readPublishedBooks(),
    fetchPublicCatalog(
      "published/videos/index.json",
      LibraryVideoCatalogSchema,
      { updatedAt: new Date().toISOString(), videos: [] },
    ),
    fetchPublicCatalog(
      "published/shorts/index.json",
      PublicShortCatalogSchema,
      { updatedAt: new Date().toISOString(), shorts: [] },
    ),
  ]);
  return { books, sermons: videos.videos, shorts: shorts.shorts };
}

export async function readPublishedBooks(): Promise<PublishedBookEntry[]> {
  const catalog = await fetchPublicCatalog(
    "published/index.json",
    PublishedCatalogSchema,
    { updatedAt: new Date().toISOString(), books: [] },
  );
  return catalog.books;
}
