import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { env } from "@/lib/env";
import {
  LibraryCoverValidationError,
  readLibraryBranding,
  removeLibraryCover,
  saveLibraryAppearance,
  saveLibraryCover,
} from "@/lib/library-branding-store";
import {
  LibraryAppearanceUpdateSchema,
  LibraryBrandingSchema,
} from "@/lib/schemas/library-branding";

export const runtime = "nodejs";

const CoverFormSchema = z.object({
  coverImage: z.instanceof(File),
}).strict();
const MAX_COVER_REQUEST_BYTES = 10 * 1024 * 1024 + 64 * 1024;

function authConfigured(): boolean {
  return Boolean(env.AUTH_PASSWORD && env.AUTH_COOKIE_SECRET);
}

function jsonResponse(branding: z.infer<typeof LibraryBrandingSchema>) {
  return NextResponse.json(branding, {
    headers: { "Cache-Control": "public, max-age=60" },
  });
}

function authRequiredResponse() {
  return NextResponse.json(
    { error: "Configure Director authentication before updating PJDL branding." },
    { status: 503 },
  );
}

export async function GET() {
  try {
    return jsonResponse(await readLibraryBranding());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not load PJDL branding settings." },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  if (!authConfigured()) return authRequiredResponse();

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_COVER_REQUEST_BYTES) {
    return NextResponse.json({ error: "Cover images must be 10 MB or smaller." }, { status: 413 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid PJDL cover image upload." },
      { status: 400 },
    );
  }
  const entries = [...formData.keys()];
  if (entries.length !== 1 || entries[0] !== "coverImage") {
    return NextResponse.json({ error: "Choose one image to upload as the PJDL cover." }, { status: 400 });
  }
  const input = CoverFormSchema.safeParse({ coverImage: formData.get("coverImage") });
  if (!input.success) {
    return NextResponse.json({ error: input.error.issues[0]?.message ?? "Choose a cover image." }, { status: 400 });
  }

  try {
    const branding = await saveLibraryCover(input.data.coverImage);
    revalidatePath("/library");
    return jsonResponse(branding);
  } catch (error) {
    const status = error instanceof LibraryCoverValidationError ? 400 : 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not upload the PJDL cover image." },
      { status },
    );
  }
}

export async function PUT(request: NextRequest) {
  if (!authConfigured()) return authRequiredResponse();

  let input: unknown;
  try {
    input = await request.json() as unknown;
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid PJDL appearance update." },
      { status: 400 },
    );
  }

  const parsed = LibraryAppearanceUpdateSchema.safeParse(input);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid PJDL appearance settings." }, { status: 400 });
  }
  try {
    const branding = await saveLibraryAppearance(parsed.data);
    revalidatePath("/library");
    return jsonResponse(branding);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not save PJDL appearance settings." },
      { status: 500 },
    );
  }
}

export async function DELETE() {
  if (!authConfigured()) return authRequiredResponse();
  try {
    const branding = await removeLibraryCover();
    revalidatePath("/library");
    return jsonResponse(branding);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not remove the PJDL cover image." },
      { status: 500 },
    );
  }
}
