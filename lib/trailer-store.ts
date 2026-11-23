import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { z } from "zod";
import { env } from "@/lib/env";
import { makeR2Client } from "@/lib/r2-storage";
import {
  PublicTrailerCatalogSchema,
  PublishedTrailerSchema,
  TrailerCatalogSchema,
  TrailerProjectSchema,
  TrailerSlugSchema,
  type TrailerProject,
} from "@/lib/schemas/trailer";
import { ShortAspectRatioSchema } from "@/lib/schemas/video-short";

const TRAILER_CATALOG_KEY = "director/trailers/index.json";
const PUBLIC_TRAILER_CATALOG_KEY = "published/trailers/index.json";

export function hasTrailerStorageConfiguration(): boolean {
  return Boolean(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET_NAME);
}

function assertStorageConfigured(): void {
  if (!hasTrailerStorageConfiguration()) {
    throw new Error("Configure Cloudflare R2 credentials and bucket to save Trailer Studio projects.");
  }
}

async function readJsonObject(key: string): Promise<unknown | null> {
  assertStorageConfigured();
  try {
    const result = await makeR2Client().send(new GetObjectCommand({
      Bucket: env.R2_BUCKET_NAME,
      Key: key,
    }));
    const raw = await result.Body?.transformToString();
    if (!raw) throw new Error(`R2 object ${key} is empty.`);
    return JSON.parse(raw) as unknown;
  } catch (error) {
    if (error instanceof Error && ["NoSuchKey", "NotFound"].includes(error.name)) return null;
    throw error;
  }
}

async function writeJsonObject(key: string, value: unknown, isPublic = false): Promise<void> {
  assertStorageConfigured();
  await makeR2Client().send(new PutObjectCommand({
    Bucket: env.R2_BUCKET_NAME,
    Key: key,
    Body: JSON.stringify(value),
    ContentType: "application/json",
    CacheControl: isPublic ? "public, max-age=60" : "private, no-store",
  }));
}

async function deleteObject(key: string): Promise<void> {
  assertStorageConfigured();
  await makeR2Client().send(new DeleteObjectCommand({
    Bucket: env.R2_BUCKET_NAME,
    Key: key,
  }));
}

async function deletePublishedTrailerAsset(videoUrl: string): Promise<void> {
  if (!env.R2_PUBLIC_URL) throw new Error("Configure R2_PUBLIC_URL before managing published trailer assets.");
  const baseUrl = new URL(`${env.R2_PUBLIC_URL.replace(/\/$/, "")}/`);
  const assetUrl = new URL(videoUrl);
  const basePath = baseUrl.pathname.replace(/\/$/, "");
  const key = decodeURIComponent(assetUrl.pathname.slice(basePath.length + 1));
  if (
    assetUrl.origin !== baseUrl.origin
    || !key.startsWith("published/trailers/assets/")
  ) {
    throw new Error("The published trailer asset is outside the Trailer Studio storage path.");
  }
  await deleteObject(key);
}

export async function listTrailers() {
  const raw = await readJsonObject(TRAILER_CATALOG_KEY);
  return raw
    ? TrailerCatalogSchema.parse(raw)
    : { updatedAt: new Date().toISOString(), trailers: [] };
}

export async function listPublicTrailers() {
  const raw = await readJsonObject(PUBLIC_TRAILER_CATALOG_KEY);
  return raw
    ? PublicTrailerCatalogSchema.parse(raw)
    : { updatedAt: new Date().toISOString(), trailers: [] };
}

export async function readPublicTrailer(slug: string) {
  const raw = await readJsonObject(`published/trailers/${slug}.json`);
  return raw ? PublishedTrailerSchema.parse(raw) : null;
}

export async function readTrailer(slug: string): Promise<TrailerProject | null> {
  const raw = await readJsonObject(`director/trailers/${slug}.json`);
  return raw ? TrailerProjectSchema.parse(raw) : null;
}

async function updatePrivateTrailerStatus(slug: string, status: "draft" | "published"): Promise<void> {
  const catalog = await listTrailers();
  const trailer = catalog.trailers.find((item) => item.slug === slug);
  if (!trailer) throw new Error("Trailer project not found.");
  await writeJsonObject(TRAILER_CATALOG_KEY, TrailerCatalogSchema.parse({
    updatedAt: new Date().toISOString(),
    trailers: [{ ...trailer, status }, ...catalog.trailers.filter((item) => item.slug !== slug)],
  }));
}

export async function saveTrailer(input: unknown): Promise<TrailerProject> {
  const project = TrailerProjectSchema.parse(input);
  const catalog = await listTrailers();
  if (!catalog.trailers.some((trailer) => trailer.slug === project.slug) && catalog.trailers.length >= 500) {
    throw new Error("The Trailer Studio catalog has reached its 500-project limit.");
  }
  const saved = TrailerProjectSchema.parse({ ...project, updatedAt: new Date().toISOString() });
  await writeJsonObject(`director/trailers/${saved.slug}.json`, saved);
  await writeJsonObject(TRAILER_CATALOG_KEY, TrailerCatalogSchema.parse({
    updatedAt: new Date().toISOString(),
    trailers: [
      {
        slug: saved.slug,
        title: saved.title,
        updatedAt: saved.updatedAt,
        status: catalog.trailers.find((trailer) => trailer.slug === saved.slug)?.status ?? "draft",
      },
      ...catalog.trailers.filter((trailer) => trailer.slug !== saved.slug),
    ],
  }));
  return saved;
}

export async function publishTrailer(input: unknown) {
  const request = z.object({
    slug: TrailerSlugSchema,
    title: z.string().trim().min(1).max(120),
    videoUrl: PublishedTrailerSchema.shape.videoUrl,
    aspectRatio: ShortAspectRatioSchema,
  }).strict().parse(input);
  if (!env.R2_PUBLIC_URL) {
    throw new Error("Configure R2_PUBLIC_URL before publishing a trailer.");
  }
  const expectedPrefix = `${env.R2_PUBLIC_URL.replace(/\/$/, "")}/published/trailers/assets/`;
  const uploadedUrl = new URL(request.videoUrl);
  const expectedAssetUrl = new URL(expectedPrefix);
  if (uploadedUrl.origin !== expectedAssetUrl.origin || !uploadedUrl.pathname.startsWith(expectedAssetUrl.pathname)) {
    throw new Error("The rendered video must be uploaded through Trailer Studio before publishing.");
  }
  const project = await readTrailer(request.slug);
  if (!project?.source.uploadedFileName) {
    throw new Error("Save a trailer with an uploaded source before publishing.");
  }
  if (project.title !== request.title || project.aspectRatio !== request.aspectRatio) {
    throw new Error("Save the latest trailer title and frame settings before publishing.");
  }

  const catalog = await listPublicTrailers();
  if (!catalog.trailers.some((trailer) => trailer.slug === request.slug) && catalog.trailers.length >= 500) {
    throw new Error("The public trailer library has reached its 500-trailer limit.");
  }
  const published = PublishedTrailerSchema.parse({
    ...request,
    updatedAt: new Date().toISOString(),
  });
  const previous = await readPublicTrailer(published.slug);
  const updatedCatalog = PublicTrailerCatalogSchema.parse({
    updatedAt: published.updatedAt,
    trailers: [
      {
        slug: published.slug,
        title: published.title,
        aspectRatio: published.aspectRatio,
        updatedAt: published.updatedAt,
      },
      ...catalog.trailers.filter((trailer) => trailer.slug !== published.slug),
    ],
  });
  await writeJsonObject(`published/trailers/${published.slug}.json`, published, true);
  await writeJsonObject(PUBLIC_TRAILER_CATALOG_KEY, updatedCatalog, true);
  await updatePrivateTrailerStatus(published.slug, "published");
  if (previous && previous.videoUrl !== published.videoUrl) {
    await deletePublishedTrailerAsset(previous.videoUrl);
  }
  return published;
}

export async function unpublishTrailer(slug: string): Promise<void> {
  const catalog = await listPublicTrailers();
  const trailer = catalog.trailers.find((item) => item.slug === slug);
  if (!trailer) {
    throw new Error("This trailer is not currently published.");
  }
  const published = await readPublicTrailer(slug);
  if (published) await deletePublishedTrailerAsset(published.videoUrl);
  await deleteObject(`published/trailers/${slug}.json`);
  await writeJsonObject(PUBLIC_TRAILER_CATALOG_KEY, PublicTrailerCatalogSchema.parse({
    updatedAt: new Date().toISOString(),
    trailers: catalog.trailers.filter((trailer) => trailer.slug !== slug),
  }), true);
  await updatePrivateTrailerStatus(slug, "draft");
}

export async function deleteTrailer(slug: string): Promise<void> {
  const catalog = await listTrailers();
  const trailer = catalog.trailers.find((item) => item.slug === slug);
  if (!trailer) {
    throw new Error("Trailer project not found.");
  }
  if (trailer.status === "published") {
    throw new Error("Unpublish this trailer before deleting its draft.");
  }
  await deleteObject(`director/trailers/${slug}.json`);
  await writeJsonObject(TRAILER_CATALOG_KEY, TrailerCatalogSchema.parse({
    updatedAt: new Date().toISOString(),
    trailers: catalog.trailers.filter((trailer) => trailer.slug !== slug),
  }));
}
