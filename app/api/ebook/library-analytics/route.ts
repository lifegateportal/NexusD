import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readLibraryTraffic } from "@/lib/library-analytics";

export const runtime = "nodejs";

const DaysSchema = z.coerce.number().int().refine((value) => [7, 30, 90].includes(value));

export async function GET(request: NextRequest) {
  if (!process.env.AUTH_PASSWORD || !process.env.AUTH_COOKIE_SECRET) {
    return NextResponse.json(
      { error: "Configure Director authentication before viewing library analytics." },
      { status: 503 },
    );
  }
  const parsedDays = DaysSchema.safeParse(request.nextUrl.searchParams.get("days") ?? "30");
  if (!parsedDays.success) {
    return NextResponse.json({ error: "Choose an analytics range of 7, 30, or 90 days." }, { status: 400 });
  }

  try {
    return NextResponse.json(await readLibraryTraffic(parsedDays.data), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    console.error("Could not load public library traffic:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not load public library traffic." },
      { status: 503 },
    );
  }
}
