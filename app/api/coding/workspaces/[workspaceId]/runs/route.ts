import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  CodingRunRequestSchema,
  CodingRunSchema,
  CodingWorkspaceIdSchema,
} from "@/lib/coding-workspace";
import { env } from "@/lib/env";
import {
  CodingWorkspaceStorageError,
  getCodingWorkspace,
} from "@/lib/coding-workspace-storage";

export const runtime = "nodejs";
export const maxDuration = 30;

type RouteContext = { params: Promise<{ workspaceId: string }> };

function errorResponse(error: unknown) {
  if (error instanceof CodingWorkspaceStorageError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error("[coding/workspaces/:id/runs] Request failed", error);
  return NextResponse.json({ error: "Coding runner request failed." }, { status: 500 });
}

export async function POST(request: NextRequest, ctx: RouteContext) {
  const { workspaceId: rawWorkspaceId } = await ctx.params;
  const parsedWorkspaceId = CodingWorkspaceIdSchema.safeParse(rawWorkspaceId);
  if (!parsedWorkspaceId.success) {
    return NextResponse.json({ error: "Invalid coding workspace id." }, { status: 400 });
  }

  let input: z.infer<typeof CodingRunRequestSchema>;
  try {
    input = CodingRunRequestSchema.parse(await request.json() as unknown);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof z.ZodError ? error.issues : "Invalid coding run request." },
      { status: 400 },
    );
  }

  if (!env.CODING_RUNNER_URL) {
    return NextResponse.json(
      { error: "The isolated coding runner is not configured. Workspace editing remains available." },
      { status: 503 },
    );
  }

  try {
    const snapshot = await getCodingWorkspace(parsedWorkspaceId.data);
    if (!snapshot) return NextResponse.json({ error: "Coding workspace not found." }, { status: 404 });
    if (snapshot.workspace.currentRevisionId !== input.revisionId) {
      return NextResponse.json(
        { error: "Run the current coding workspace revision before starting a command." },
        { status: 409 },
      );
    }

    const runnerResponse = await fetch(`${env.CODING_RUNNER_URL.replace(/\/$/, "")}/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(env.CODING_RUNNER_TOKEN ? { Authorization: `Bearer ${env.CODING_RUNNER_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        workspaceId: parsedWorkspaceId.data,
        revisionId: input.revisionId,
        command: input.command,
        network: input.network,
        files: snapshot.revision.files,
      }),
      signal: AbortSignal.timeout(25_000),
    });
    const payload = await runnerResponse.json().catch(() => null) as unknown;
    if (!runnerResponse.ok) {
      const failure = payload as { error?: unknown } | null;
      return NextResponse.json(
        { error: typeof failure?.error === "string" ? failure.error : "The isolated runner rejected the command." },
        { status: runnerResponse.status >= 400 && runnerResponse.status < 500 ? runnerResponse.status : 502 },
      );
    }
    const run = CodingRunSchema.safeParse(payload);
    if (!run.success) {
      console.error("[coding/workspaces/:id/runs] Runner returned invalid run data", run.error.issues);
      return NextResponse.json({ error: "The isolated runner returned invalid run data." }, { status: 502 });
    }
    return NextResponse.json({ run: run.data }, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
