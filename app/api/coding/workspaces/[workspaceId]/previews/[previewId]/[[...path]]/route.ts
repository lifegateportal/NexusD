import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { CodingPreviewSchema, CodingWorkspaceIdSchema } from "@/lib/coding-workspace";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const maxDuration = 60;

type RouteContext = { params: Promise<{ workspaceId: string; previewId: string; path?: string[] }> };

function previewResponse(
  preview: z.infer<typeof CodingPreviewSchema>,
  workspaceId: string,
) {
  return {
    ...preview,
    previewUrl: preview.status === "running"
      ? `/api/coding/workspaces/${encodeURIComponent(workspaceId)}/previews/${encodeURIComponent(preview.id)}`
      : null,
  };
}

export async function GET(request: NextRequest, ctx: RouteContext) {
  const { path = [] } = await ctx.params;
  return path.length === 0 ? handleStatus("GET", ctx) : proxy(request, ctx);
}

export async function HEAD(request: NextRequest, ctx: RouteContext) {
  return proxy(request, ctx);
}

export async function DELETE(_request: NextRequest, ctx: RouteContext) {
  return handleStatus("DELETE", ctx);
}

async function requestRunner(
  method: "GET" | "DELETE",
  previewId: string,
) {
  return fetch(`${env.CODING_RUNNER_URL?.replace(/\/$/, "")}/previews/${encodeURIComponent(previewId)}`, {
    method,
    headers: env.CODING_RUNNER_TOKEN
      ? { Authorization: `Bearer ${env.CODING_RUNNER_TOKEN}` }
      : undefined,
    signal: AbortSignal.timeout(25_000),
  });
}

async function handleStatus(method: "GET" | "DELETE", ctx: RouteContext) {
  const { workspaceId, previewId } = await ctx.params;
  if (!CodingWorkspaceIdSchema.safeParse(workspaceId).success || !/^preview-[a-z0-9-]{8,100}$/.test(previewId)) {
    return NextResponse.json({ error: "Invalid coding preview identifier." }, { status: 400 });
  }
  if (!env.CODING_RUNNER_URL) {
    return NextResponse.json({ error: "The isolated coding runner is not configured." }, { status: 503 });
  }
  try {
    const response = await requestRunner(method, previewId);
    const payload = await response.json().catch(() => null) as { preview?: unknown; error?: unknown } | null;
    if (!response.ok) {
      return NextResponse.json(
        { error: typeof payload?.error === "string" ? payload.error : "The coding preview request failed." },
        { status: response.status >= 400 && response.status < 500 ? response.status : 502 },
      );
    }
    const parsed = CodingPreviewSchema.safeParse(payload?.preview);
    if (!parsed.success) {
      console.error("[coding/previews/:id] Runner returned invalid preview data", parsed.error.issues);
      return NextResponse.json({ error: "The isolated runner returned invalid preview data." }, { status: 502 });
    }
    return NextResponse.json({ preview: previewResponse(parsed.data, workspaceId) });
  } catch (error) {
    console.error("[coding/previews/:id] Request failed", error);
    return NextResponse.json({ error: "Coding preview request failed." }, { status: 502 });
  }
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
