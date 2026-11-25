import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { env } from "@/lib/env";
import { makeR2Client } from "@/lib/r2-storage";
import {
  LibraryAppearanceUpdateSchema,
  LibraryBrandingSchema,
  LibraryCoverImageTypeSchema,
  type LibraryBranding,
} from "@/lib/schemas/library-branding";

export class LibraryCoverValidationError extends Error {}

const BRANDING_KEY = "published/pjdl/branding.json";
const COVER_IMAGE_PREFIX = "published/pjdl/hero-covers/";
const MAX_COVER_BYTES = 10 * 1024 * 1024;
const DEFAULT_BRANDING = LibraryBrandingSchema.parse({});

function getStorageConfig() {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_URL } = env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME || !R2_PUBLIC_URL) {
    return null;
  }
  return { bucket: R2_BUCKET_NAME, publicUrl: R2_PUBLIC_URL };
}

function isPjdlCoverUrl(value: string, publicUrl: string): boolean {
  try {
    const publicBase = new URL(publicUrl);
    const coverUrl = new URL(value);
    const publicPath = `${publicBase.pathname.replace(/\/$/, "")}/${COVER_IMAGE_PREFIX}`;
    return coverUrl.origin === publicBase.origin
      && coverUrl.protocol === publicBase.protocol
      && coverUrl.pathname.startsWith(publicPath)
      && !coverUrl.search
      && !coverUrl.hash;
  } catch {
    return false;
  }
}

function parseBranding(value: unknown, publicUrl?: string): LibraryBranding {
  const branding = LibraryBrandingSchema.parse(value);
  if (branding.coverImageUrl && publicUrl && !isPjdlCoverUrl(branding.coverImageUrl, publicUrl)) {
    throw new Error("The saved PJDL cover image URL is invalid.");
  }
  return branding;
}

async function readPublicBranding(publicUrl: string): Promise<LibraryBranding> {
  const response = await fetch(`${publicUrl.replace(/\/$/, "")}/${BRANDING_KEY}`, { cache: "no-store" });
  if (response.status === 404) return DEFAULT_BRANDING;
  if (!response.ok) throw new Error(`Could not load PJDL branding settings (HTTP ${response.status}).`);
  return parseBranding(await response.json() as unknown, publicUrl);
}

export async function readLibraryBranding(): Promise<LibraryBranding> {
  const storage = getStorageConfig();
  if (!storage) {
    return env.R2_PUBLIC_URL ? readPublicBranding(env.R2_PUBLIC_URL) : DEFAULT_BRANDING;
  }

  try {
    const result = await makeR2Client().send(new GetObjectCommand({
      Bucket: storage.bucket,
      Key: BRANDING_KEY,
    }));
    const raw = await result.Body?.transformToString();
    if (!raw) throw new Error("The saved PJDL branding settings are empty.");
    return parseBranding(JSON.parse(raw) as unknown, storage.publicUrl);
  } catch (error) {
    if (error instanceof Error && ["NoSuchKey", "NotFound"].includes(error.name)) return DEFAULT_BRANDING;
    throw error;
  }
}

async function writeLibraryBranding(branding: LibraryBranding): Promise<LibraryBranding> {
  const storage = getStorageConfig();
  if (!storage) throw new Error("Configure Cloudflare R2 storage before updating PJDL branding.");
  const validated = parseBranding(branding, storage.publicUrl);
  await makeR2Client().send(new PutObjectCommand({
    Bucket: storage.bucket,
    Key: BRANDING_KEY,
    Body: JSON.stringify(validated),
    ContentType: "application/json",
    CacheControl: "public, max-age=60",
  }));
  return validated;
}

export async function saveLibraryAppearance(input: unknown): Promise<LibraryBranding> {
  const appearance = LibraryAppearanceUpdateSchema.parse(input);
  const current = await readLibraryBranding();
  return writeLibraryBranding({ ...current, ...appearance });
}

export async function saveLibraryCover(file: File): Promise<LibraryBranding> {
  const storage = getStorageConfig();
  if (!storage) throw new Error("Configure Cloudflare R2 storage before uploading the PJDL cover.");
  if (file.size < 1 || file.size > MAX_COVER_BYTES) {
    throw new LibraryCoverValidationError("Choose an image file up to 10 MB.");
  }

  const parsedType = LibraryCoverImageTypeSchema.safeParse(file.type);
  if (!parsedType.success) throw new LibraryCoverValidationError("Choose a JPEG, PNG, or WebP image.");
  const extensionByType = {
    "image/jpeg": { extension: "jpg", signature: [0xff, 0xd8, 0xff] },
    "image/png": { extension: "png", signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
    "image/webp": { extension: "webp", signature: null },
  } as const;
  const imageType = extensionByType[parsedType.data];

  const bytes = new Uint8Array(await file.arrayBuffer());
  const matchesSignature = imageType.signature
    ? imageType.signature.every((byte, index) => bytes[index] === byte)
    : bytes.length >= 12
      && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF"
      && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  if (!matchesSignature) throw new LibraryCoverValidationError("The selected file does not match its image format.");

  const key = `${COVER_IMAGE_PREFIX}${crypto.randomUUID()}.${imageType.extension}`;
  await makeR2Client().send(new PutObjectCommand({
    Bucket: storage.bucket,
    Key: key,
    Body: bytes,
    ContentType: parsedType.data,
    CacheControl: "public, max-age=31536000, immutable",
  }));
  const current = await readLibraryBranding();
  return writeLibraryBranding({
    ...current,
    coverImageUrl: `${storage.publicUrl.replace(/\/$/, "")}/${key}`,
  });
}

export async function removeLibraryCover(): Promise<LibraryBranding> {
  const current = await readLibraryBranding();
  return writeLibraryBranding({ ...current, coverImageUrl: null });
}
