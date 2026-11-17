import { NextResponse } from "next/server";
import { listPublicShorts } from "@/lib/shorts-store";

export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json(await listPublicShorts(), {
      headers: { "Cache-Control": "public, max-age=60" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not load published video shorts." },
      { status: 502 },
    );
  }
}
