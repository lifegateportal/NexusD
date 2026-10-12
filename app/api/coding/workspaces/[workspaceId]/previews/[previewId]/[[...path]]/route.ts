import { NextRequest, NextResponse } from "next/server";
import { CodingWorkspaceIdSchema } from "@/lib/coding-workspace";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const maxDuration = 60;

type RouteContext = { params: Promise<{ workspaceId: string; previewId: string; path?: string[] }> };

export async function GET(request: NextRequest, ctx: RouteContext) {
  return proxy(request, ctx);
}

export async function HEAD(request: NextRequest, ctx: RouteContext) {
  return proxy(request, ctx);
}

async function proxy(request: NextRequest, ctx: RouteContext) {
  const { workspaceId, previewId, path = [] } = await ctx.params;
  if (!CodingWorkspaceIdSchema.safeParse(workspaceId).success || !/^preview-[a-z0-9-]{8,100}$/.test(previewId)) {
    return NextResponse.json({ error: "Invalid coding preview identifier." }, { status: 400 });
  }
  if (!env.CODING_RUNNER_URL) {
    return NextResponse.json({ error: "The isolated coding runner is not configured." }, { status: 503 });
  }
  const suffix = path.length > 0 ? `/${path.map(encodeURIComponent).join("/")}` : "/";
  const target = `${env.CODING_RUNNER_URL.replace(/\/$/, "")}/previews/${encodeURIComponent(previewId)}${suffix}${request.nextUrl.search}`;
  try {
    const response = await fetch(target, {
      method: request.method,
      headers: {
        Authorization: `Bearer ${env.CODING_RUNNER_TOKEN}`,
        Accept: request.headers.get("accept") || "*/*",
        Range: request.headers.get("range") || "",
      },
      signal: AbortSignal.timeout(55_000),
    });
    const headers = new Headers();
    const contentType = response.headers.get("content-type");
    if (contentType) headers.set("content-type", contentType);
    const contentLength = response.headers.get("content-length");
    if (contentLength) headers.set("content-length", contentLength);
    headers.set("cache-control", "no-store");
    return new Response(request.method === "HEAD" ? null : response.body, {
      status: response.status,
      headers,
    });
  } catch (error) {
    console.error("[coding/previews/proxy] Request failed", error);
    return NextResponse.json({ error: "Preview server is unavailable." }, { status: 502 });
  }
}
