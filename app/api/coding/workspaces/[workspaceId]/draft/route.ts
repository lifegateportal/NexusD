import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  CodingWorkspaceIdSchema,
  SaveCodingDraftSchema,
} from "@/lib/coding-workspace";
import {
  CodingWorkspaceConflictError,
  CodingWorkspaceStorageError,
  saveCodingDraft,
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
  console.error("[coding/workspaces/:id/draft] Request failed", error);
  return NextResponse.json({ error: "Coding workspace draft could not be saved." }, { status: 500 });
}

async function parseWorkspaceId(ctx: RouteContext): Promise<string | NextResponse> {
  const { workspaceId } = await ctx.params;
  const parsed = CodingWorkspaceIdSchema.safeParse(workspaceId);
  return parsed.success
    ? parsed.data
    : NextResponse.json({ error: "Invalid coding workspace id." }, { status: 400 });
}

export async function PUT(request: NextRequest, ctx: RouteContext) {
  const workspaceId = await parseWorkspaceId(ctx);
  if (workspaceId instanceof NextResponse) return workspaceId;

  let input: z.infer<typeof SaveCodingDraftSchema>;
  try {
    input = SaveCodingDraftSchema.parse(await request.json() as unknown);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof z.ZodError ? error.issues : "Invalid coding workspace draft." },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json(
      await saveCodingDraft(
        workspaceId,
        input.baseRevisionId,
        input.files,
        input.reason,
        input.source,
      ),
      { status: 200 },
    );
  } catch (error) {
    return storageErrorResponse(error);
  }
}
