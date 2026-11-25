import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { makeR2Client } from "@/lib/r2-storage";
import {
  LibraryBrandingSchema,
  LibraryBrandingUpdateSchema,
  LibraryCoverUploadRequestSchema,
  LibraryCoverUploadResponseSchema,
} from "@/lib/schemas/library-branding";

export const runtime = "nodejs";

const BRANDING_KEY = "published/pjdl/branding.json";
const COVER_IMAGE_PREFIX = "published/pjdl/hero-covers/";

function getStorageConfig() {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_URL } = env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME || !R2_PUBLIC_URL) {
    return null;
  }
  return { bucket: R2_BUCKET_NAME, publicUrl: R2_PUBLIC_URL };
}

function authConfigured(): boolean {
  return Boolean(process.env.AUTH_PASSWORD && process.env.AUTH_COOKIE_SECRET);
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

function jsonResponse(branding: z.infer<typeof LibraryBrandingSchema>) {
  return NextResponse.json(branding, {
    headers: { "Cache-Control": "public, max-age=60" },
  });
}

async function readPublicBranding(publicUrl: string) {
  const response = await fetch(`${publicUrl.replace(/\/$/, "")}/${BRANDING_KEY}`, { cache: "no-store" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Could not load PJDL branding settings (HTTP ${response.status}).`);
  const branding = LibraryBrandingSchema.safeParse(await response.json() as unknown);
  if (!branding.success) throw new Error("The saved PJDL branding settings are invalid.");
  if (branding.data.coverImageUrl && !isPjdlCoverUrl(branding.data.coverImageUrl, publicUrl)) {
    throw new Error("The saved PJDL cover image URL is invalid.");
  }
  return branding.data;
}

export async function GET() {
  const storage = getStorageConfig();
  if (!storage) {
    if (!env.R2_PUBLIC_URL) return jsonResponse({ coverImageUrl: null });
    try {
      return jsonResponse(await readPublicBranding(env.R2_PUBLIC_URL) ?? { coverImageUrl: null });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Could not load the PJDL cover image." },
        { status: 502 },
      );
    }
  }

  try {
    const result = await makeR2Client().send(new GetObjectCommand({
      Bucket: storage.bucket,
      Key: BRANDING_KEY,
    }));
    const raw = await result.Body?.transformToString();
    if (!raw) throw new Error("The saved PJDL branding settings are empty.");
    const branding = LibraryBrandingSchema.parse(JSON.parse(raw) as unknown);
    if (branding.coverImageUrl && !isPjdlCoverUrl(branding.coverImageUrl, storage.publicUrl)) {
      throw new Error("The saved PJDL cover image URL is invalid.");
    }
    return jsonResponse(branding);
  } catch (error) {
    if (error instanceof Error && ["NoSuchKey", "NotFound"].includes(error.name)) {
      return jsonResponse({ coverImageUrl: null });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not load the PJDL cover image." },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  if (!authConfigured()) {
    return NextResponse.json({ error: "Configure Director authentication before updating the PJDL cover." }, { status: 503 });
  }
  const storage = getStorageConfig();
  if (!storage) {
    return NextResponse.json({ error: "Configure Cloudflare R2 storage before uploading the PJDL cover." }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await request.json() as unknown;
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid cover upload request." },
      { status: 400 },
    );
  }
  const parsedInput = LibraryCoverUploadRequestSchema.safeParse(body);
  if (!parsedInput.success) {
    return NextResponse.json({ error: parsedInput.error.issues[0]?.message ?? "Invalid cover upload request." }, { status: 400 });
  }

  try {
    const input = parsedInput.data;
    const extensionByType = {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
    };
    const key = `${COVER_IMAGE_PREFIX}${crypto.randomUUID()}.${extensionByType[input.contentType]}`;
    const presignedUrl = await getSignedUrl(makeR2Client(), new PutObjectCommand({
      Bucket: storage.bucket,
      Key: key,
      ContentType: input.contentType,
    }), { expiresIn: 3600 });
    const upload = LibraryCoverUploadResponseSchema.parse({
      presignedUrl,
      coverImageUrl: `${storage.publicUrl.replace(/\/$/, "")}/${key}`,
      contentType: input.contentType,
    });
    return NextResponse.json(upload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not prepare the PJDL cover upload." },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest) {
  if (!authConfigured()) {
    return NextResponse.json({ error: "Configure Director authentication before updating the PJDL cover." }, { status: 503 });
  }
  const storage = getStorageConfig();
  if (!storage) {
    return NextResponse.json({ error: "Configure Cloudflare R2 storage before updating the PJDL cover." }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await request.json() as unknown;
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid PJDL branding update." },
      { status: 400 },
    );
  }
  const parsedInput = LibraryBrandingUpdateSchema.safeParse(body);
  if (!parsedInput.success) {
    return NextResponse.json({ error: parsedInput.error.issues[0]?.message ?? "Invalid PJDL branding update." }, { status: 400 });
  }
  if (!isPjdlCoverUrl(parsedInput.data.coverImageUrl, storage.publicUrl)) {
    return NextResponse.json({ error: "The cover image must be uploaded to the PJDL cover storage path." }, { status: 400 });
  }

  try {
    const branding = LibraryBrandingSchema.parse(parsedInput.data);
    await makeR2Client().send(new PutObjectCommand({
      Bucket: storage.bucket,
      Key: BRANDING_KEY,
      Body: JSON.stringify(branding),
      ContentType: "application/json",
      CacheControl: "public, max-age=60",
    }));
    return jsonResponse(branding);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not save the PJDL cover image." },
      { status: 500 },
    );
  }
}

export async function DELETE() {
  if (!authConfigured()) {
    return NextResponse.json({ error: "Configure Director authentication before updating the PJDL cover." }, { status: 503 });
  }
  const storage = getStorageConfig();
  if (!storage) {
    return NextResponse.json({ error: "Configure Cloudflare R2 storage before updating the PJDL cover." }, { status: 503 });
  }

  try {
    const branding = LibraryBrandingSchema.parse({ coverImageUrl: null });
    await makeR2Client().send(new PutObjectCommand({
      Bucket: storage.bucket,
      Key: BRANDING_KEY,
      Body: JSON.stringify(branding),
      ContentType: "application/json",
      CacheControl: "public, max-age=60",
    }));
    return jsonResponse(branding);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not remove the PJDL cover image." },
      { status: 500 },
    );
  }
}
