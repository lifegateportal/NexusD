import { z } from "zod";
import {
  LibraryAppearanceUpdateSchema,
  LibraryBrandingSchema,
  type LibraryAppearanceUpdate,
  type LibraryBranding,
} from "@/lib/schemas/library-branding";

const ErrorResponseSchema = z.object({ error: z.string() }).strict();

async function parseResponse(response: Response): Promise<LibraryBranding> {
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
  const parsed = LibraryBrandingSchema.safeParse(body);
  if (!parsed.success) throw new Error("The library service returned invalid appearance settings.");
  return parsed.data;
}

export async function saveLibraryAppearance(input: LibraryAppearanceUpdate): Promise<LibraryBranding> {
  const appearance = LibraryAppearanceUpdateSchema.parse(input);
  return parseResponse(await fetch("/api/library/branding", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(appearance),
  }));
}

export async function uploadLibraryCover(file: File): Promise<LibraryBranding> {
  const formData = new FormData();
  formData.set("coverImage", file);
  return parseResponse(await fetch("/api/library/branding", {
    method: "POST",
    body: formData,
  }));
}

export async function removeLibraryCover(): Promise<LibraryBranding> {
  return parseResponse(await fetch("/api/library/branding", { method: "DELETE" }));
}
