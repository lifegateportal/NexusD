import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { recordLibraryPageView } from "@/lib/library-analytics";
import { LibraryTrafficEventInputSchema } from "@/lib/schemas/library-analytics";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const requestHost = forwardedHost || request.headers.get("host");
  if (!origin || !requestHost) {
    return NextResponse.json({ error: "A same-origin request is required." }, { status: 403 });
  }
  try {
    if (new URL(origin).host.toLowerCase() !== requestHost.toLowerCase()) {
      return NextResponse.json({ error: "A same-origin request is required." }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "The request origin is invalid." }, { status: 403 });
  }

  if (request.headers.get("dnt") === "1") {
    return new NextResponse(null, { status: 204 });
  }
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 4096) {
    return NextResponse.json({ error: "Traffic event is too large." }, { status: 413 });
  }

  let event: z.infer<typeof LibraryTrafficEventInputSchema>;
  try {
    event = LibraryTrafficEventInputSchema.parse(await request.json() as unknown);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid library traffic event." },
      { status: 400 },
    );
  }

  try {
    await recordLibraryPageView(event);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    console.error("Could not record public library traffic:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not record library traffic." },
      { status: 503 },
    );
  }
}
