import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  CodingPreviewRequestSchema,
  CodingPreviewSchema,
  CodingWorkspaceIdSchema,
} from "@/lib/coding-workspace";
import { env } from "@/lib/env";
import { getCodingWorkspace } from "@/lib/coding-workspace-storage";

export const runtime = "nodejs";
export const maxDuration = 30;

type RouteContext = { params: Promise<{ workspaceId: string }> };

function runnerUrl(path: string): string {
  return `${env.CODING_RUNNER_URL?.replace(/\/$/, "")}${path}`;
}

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

export async function POST(request: NextRequest, ctx: RouteContext) {
  const { workspaceId: rawWorkspaceId } = await ctx.params;
  const parsedWorkspaceId = CodingWorkspaceIdSchema.safeParse(rawWorkspaceId);
  if (!parsedWorkspaceId.success) {
    return NextResponse.json({ error: "Invalid coding workspace id." }, { status: 400 });
  }
  if (!env.CODING_RUNNER_URL) {
    return NextResponse.json({ error: "The isolated coding runner is not configured." }, { status: 503 });
  }

  let input: z.infer<typeof CodingPreviewRequestSchema>;
  try {
    input = CodingPreviewRequestSchema.parse(await request.json() as unknown);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof z.ZodError ? error.issues : "Invalid coding preview request." },
      { status: 400 },
    );
  }

  try {
    const snapshot = await getCodingWorkspace(parsedWorkspaceId.data);
    if (!snapshot) return NextResponse.json({ error: "Coding workspace not found." }, { status: 404 });
    if (snapshot.workspace.currentRevisionId !== input.revisionId) {
      return NextResponse.json(
        { error: "Start the preview from the current coding workspace revision." },
        { status: 409 },
      );
    }
    const response = await fetch(runnerUrl("/previews"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(env.CODING_RUNNER_TOKEN ? { Authorization: `Bearer ${env.CODING_RUNNER_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        workspaceId: parsedWorkspaceId.data,
        revisionId: input.revisionId,
        command: input.command,
        port: input.port,
        network: input.network,
        files: snapshot.revision.files,
      }),
      signal: AbortSignal.timeout(25_000),
    });
    const payload = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      const failure = payload as { error?: unknown } | null;
      return NextResponse.json(
        { error: typeof failure?.error === "string" ? failure.error : "The isolated runner rejected the preview." },
        { status: response.status >= 400 && response.status < 500 ? response.status : 502 },
      );
    }
    const parsed = CodingPreviewSchema.safeParse(payload);
    if (!parsed.success) {
      console.error("[coding/previews] Runner returned invalid preview data", parsed.error.issues);
      return NextResponse.json({ error: "The isolated runner returned invalid preview data." }, { status: 502 });
    }
    return NextResponse.json({ preview: previewResponse(parsed.data, parsedWorkspaceId.data) }, { status: 202 });
  } catch (error) {
    console.error("[coding/previews] Request failed", error);
    return NextResponse.json({ error: "Coding preview request failed." }, { status: 502 });
  }
}
