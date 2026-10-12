import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  CodingWorkspaceIdSchema,
  RevertCodingWorkspaceSchema,
} from "@/lib/coding-workspace";
import {
  CodingWorkspaceConflictError,
  CodingWorkspaceStorageError,
  getCodingWorkspace,
  revertCodingWorkspace,
} from "@/lib/coding-workspace-storage";

export const runtime = "nodejs";
export const maxDuration = 30;

type RouteContext = { params: Promise<{ workspaceId: string }> };

function storageErrorResponse(error: unknown) {
  if (error instanceof CodingWorkspaceConflictError) {
    return NextResponse.json(
      { error: error.message, current: error.current },
      { status: error.status },
    );
  }
  if (error instanceof CodingWorkspaceStorageError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error("[coding/workspaces/:id/revert] Request failed", error);
  return NextResponse.json({ error: "Coding workspace revert failed." }, { status: 500 });
}

async function parseWorkspaceId(ctx: RouteContext): Promise<string | NextResponse> {
  const { workspaceId } = await ctx.params;
  const parsed = CodingWorkspaceIdSchema.safeParse(workspaceId);
  return parsed.success
    ? parsed.data
    : NextResponse.json({ error: "Invalid coding workspace id." }, { status: 400 });
}

export async function POST(request: NextRequest, ctx: RouteContext) {
  const workspaceId = await parseWorkspaceId(ctx);
  if (workspaceId instanceof NextResponse) return workspaceId;

  let input: z.infer<typeof RevertCodingWorkspaceSchema>;
  try {
    input = RevertCodingWorkspaceSchema.parse(await request.json() as unknown);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof z.ZodError ? error.issues : "Invalid coding revert request." },
      { status: 400 },
    );
  }

  try {
    const current = await getCodingWorkspace(workspaceId);
    if (!current) return NextResponse.json({ error: "Coding workspace not found." }, { status: 404 });
    return NextResponse.json(
      await revertCodingWorkspace(workspaceId, current.workspace.currentRevisionId, input.revisionId),
      { status: 201 },
    );
  } catch (error) {
    return storageErrorResponse(error);
  }
}
