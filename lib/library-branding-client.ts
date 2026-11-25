import { z } from "zod";
import { LibraryVideoCatalogSchema } from "@/lib/schemas/library-video";
import { PublishedCatalogSchema } from "@/lib/schemas/published-book";
import {
  LibraryAppearanceUpdateSchema,
  LibraryBrandingSchema,
  type LibraryAppearanceUpdate,
  type LibraryBranding,
} from "@/lib/schemas/library-branding";
import { PublicShortCatalogSchema } from "@/lib/schemas/video-short";

const ErrorResponseSchema = z.object({ error: z.string() }).strict();

async function parseJsonResponse<T>(
  response: Response,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  invalidResponseMessage: string,
): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`The library service returned an unreadable response (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    const error = ErrorResponseSchema.safeParse(body);
    throw new Error(error.success ? error.data.error : `Library update failed (HTTP ${response.status}).`);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new Error(invalidResponseMessage);
  return parsed.data;
}

async function parseBrandingResponse(response: Response): Promise<LibraryBranding> {
  return parseJsonResponse<LibraryBranding>(
    response,
    LibraryBrandingSchema,
    "The library service returned invalid appearance settings.",
  );
}

export async function saveLibraryAppearance(input: LibraryAppearanceUpdate): Promise<LibraryBranding> {
  const appearance = LibraryAppearanceUpdateSchema.parse(input);
  return parseBrandingResponse(await fetch("/api/library/branding", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(appearance),
  }));
}

export async function uploadLibraryCover(file: File): Promise<LibraryBranding> {
  const formData = new FormData();
  formData.set("coverImage", file);
  return parseBrandingResponse(await fetch("/api/library/branding", {
    method: "POST",
    body: formData,
  }));
}

export async function removeLibraryCover(): Promise<LibraryBranding> {
  return parseBrandingResponse(await fetch("/api/library/branding", { method: "DELETE" }));
}

export async function fetchLibraryFeatureOptions() {
  const [booksResponse, videosResponse, shortsResponse] = await Promise.all([
    fetch("/api/library/books", { cache: "no-store" }),
    fetch("/api/library/videos", { cache: "no-store" }),
    fetch("/api/library/shorts", { cache: "no-store" }),
  ]);
  const [books, videos, shorts] = await Promise.all([
    parseJsonResponse(booksResponse, PublishedCatalogSchema, "The published book catalog has an invalid format."),
    parseJsonResponse(videosResponse, LibraryVideoCatalogSchema, "The published video catalog has an invalid format."),
    parseJsonResponse(shortsResponse, PublicShortCatalogSchema, "The published shorts catalog has an invalid format."),
  ]);
  return { books: books.books, videos: videos.videos, shorts: shorts.shorts };
}
