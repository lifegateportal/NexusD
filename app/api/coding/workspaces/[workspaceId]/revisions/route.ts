import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  CodingRevisionIdSchema,
  CodingWorkspaceIdSchema,
  SaveCodingRevisionSchema,
} from "@/lib/coding-workspace";
import {
  CodingWorkspaceConflictError,
  CodingWorkspaceStorageError,
  listCodingRevisions,
  saveCodingRevision,
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
  console.error("[coding/workspaces/:id/revisions] Request failed", error);
  return NextResponse.json({ error: "Coding workspace revision failed." }, { status: 500 });
}

async function parseWorkspaceId(ctx: RouteContext): Promise<string | NextResponse> {
  const { workspaceId } = await ctx.params;
  const parsed = CodingWorkspaceIdSchema.safeParse(workspaceId);
  return parsed.success
    ? parsed.data
    : NextResponse.json({ error: "Invalid coding workspace id." }, { status: 400 });
}

export async function GET(request: NextRequest, ctx: RouteContext) {
  const workspaceId = await parseWorkspaceId(ctx);
  if (workspaceId instanceof NextResponse) return workspaceId;
  const beforeRevisionId = request.nextUrl.searchParams.get("before");
  if (beforeRevisionId !== null && !CodingRevisionIdSchema.safeParse(beforeRevisionId).success) {
    return NextResponse.json({ error: "Invalid coding revision cursor." }, { status: 400 });
  }
  try {
    const page = await listCodingRevisions(workspaceId, beforeRevisionId ?? undefined);
    return NextResponse.json({
      revisions: page.revisions.map(({ files, ...revision }) => ({
        ...revision,
        fileCount: files.length,
      })),
      nextCursor: page.nextCursor,
    }, {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch (error) {
    return storageErrorResponse(error);
  }
}

export async function POST(request: NextRequest, ctx: RouteContext) {
  const workspaceId = await parseWorkspaceId(ctx);
  if (workspaceId instanceof NextResponse) return workspaceId;

  let input: z.infer<typeof SaveCodingRevisionSchema>;
  try {
    input = SaveCodingRevisionSchema.parse(await request.json() as unknown);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof z.ZodError ? error.issues : "Invalid coding revision request." },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json(
      await saveCodingRevision(
        workspaceId,
        input.baseRevisionId,
        input.files,
        input.reason,
        input.source,
        input.protectSnapshot,
      ),
      { status: 201 },
    );
  } catch (error) {
    return storageErrorResponse(error);
  }
}
