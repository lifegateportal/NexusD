import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { env } from "@/lib/env";
import { makeR2Client } from "@/lib/r2-storage";
import {
  TrailerCatalogSchema,
  TrailerProjectSchema,
  type TrailerProject,
} from "@/lib/schemas/trailer";

const TRAILER_CATALOG_KEY = "director/trailers/index.json";

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

async function writeJsonObject(key: string, value: unknown): Promise<void> {
  assertStorageConfigured();
  await makeR2Client().send(new PutObjectCommand({
    Bucket: env.R2_BUCKET_NAME,
    Key: key,
    Body: JSON.stringify(value),
    ContentType: "application/json",
    CacheControl: "private, no-store",
  }));
}

async function deleteObject(key: string): Promise<void> {
  assertStorageConfigured();
  await makeR2Client().send(new DeleteObjectCommand({
    Bucket: env.R2_BUCKET_NAME,
    Key: key,
  }));
}

export async function listTrailers() {
  const raw = await readJsonObject(TRAILER_CATALOG_KEY);
  return raw
    ? TrailerCatalogSchema.parse(raw)
    : { updatedAt: new Date().toISOString(), trailers: [] };
}

export async function readTrailer(slug: string): Promise<TrailerProject | null> {
  const raw = await readJsonObject(`director/trailers/${slug}.json`);
  return raw ? TrailerProjectSchema.parse(raw) : null;
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
      { slug: saved.slug, title: saved.title, updatedAt: saved.updatedAt },
      ...catalog.trailers.filter((trailer) => trailer.slug !== saved.slug),
    ],
  }));
  return saved;
}

export async function deleteTrailer(slug: string): Promise<void> {
  const catalog = await listTrailers();
  if (!catalog.trailers.some((trailer) => trailer.slug === slug)) {
    throw new Error("Trailer project not found.");
  }
  await deleteObject(`director/trailers/${slug}.json`);
  await writeJsonObject(TRAILER_CATALOG_KEY, TrailerCatalogSchema.parse({
    updatedAt: new Date().toISOString(),
    trailers: catalog.trailers.filter((trailer) => trailer.slug !== slug),
  }));
}
