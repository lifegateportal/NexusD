import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { LibraryFaqCatalogSchema } from "@/lib/schemas/library-faq";

export async function GET() {
  if (!env.R2_PUBLIC_URL) {
    return NextResponse.json({ error: "The public FAQ library is not configured." }, { status: 503 });
  }
  try {
    const response = await fetch(
      `${env.R2_PUBLIC_URL.replace(/\/$/, "")}/published/faqs/index.json`,
      { next: { revalidate: 60 } },
    );
    if (response.status === 404) {
      return NextResponse.json(
        { updatedAt: new Date().toISOString(), faqs: [] },
        { headers: { "Cache-Control": "public, max-age=60" } },
      );
    }
    if (!response.ok) {
      throw new Error(`The published FAQ request failed with HTTP ${response.status}.`);
    }
    const catalog = LibraryFaqCatalogSchema.parse(await response.json() as unknown);
    return NextResponse.json(catalog, {
      headers: { "Cache-Control": "public, max-age=60" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "The published FAQs could not be loaded." },
      { status: 502 },
    );
  }
}
