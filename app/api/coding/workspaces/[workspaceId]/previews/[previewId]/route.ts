import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { CodingPreviewSchema, CodingWorkspaceIdSchema } from "@/lib/coding-workspace";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const maxDuration = 30;

type RouteContext = { params: Promise<{ workspaceId: string; previewId: string }> };

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

export async function GET(_request: NextRequest, ctx: RouteContext) {
  return handleStatus("GET", ctx);
}

export async function DELETE(_request: NextRequest, ctx: RouteContext) {
  return handleStatus("DELETE", ctx);
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
