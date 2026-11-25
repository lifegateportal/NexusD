import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { PublishedCatalogSchema } from "@/lib/schemas/published-book";

export const runtime = "nodejs";

export async function GET() {
  const emptyCatalog = { updatedAt: new Date().toISOString(), books: [] };
  if (!env.R2_PUBLIC_URL) return NextResponse.json(emptyCatalog);

  try {
    const response = await fetch(
      `${env.R2_PUBLIC_URL.replace(/\/$/, "")}/published/index.json`,
      { next: { revalidate: 60 } },
    );
    if (response.status === 404) return NextResponse.json(emptyCatalog);
    if (!response.ok) {
      return NextResponse.json({ error: "Could not load the published book library." }, { status: 502 });
    }
    const parsed = PublishedCatalogSchema.safeParse(await response.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "The published book catalog is invalid." }, { status: 502 });
    }
    return NextResponse.json(parsed.data);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not load the published book library." },
      { status: 502 },
    );
  }
}
