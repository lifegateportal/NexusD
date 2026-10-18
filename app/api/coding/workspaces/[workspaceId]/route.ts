import { NextRequest, NextResponse } from "next/server";
import { CodingWorkspaceIdSchema } from "@/lib/coding-workspace";
import {
  deleteCodingWorkspace,
  getCodingWorkspace,
  listCodingDeployments,
  CodingWorkspaceStorageError,
} from "@/lib/coding-workspace-storage";

export const runtime = "nodejs";
export const maxDuration = 30;

type RouteContext = { params: Promise<{ workspaceId: string }> };

function storageErrorResponse(error: unknown) {
  if (error instanceof CodingWorkspaceStorageError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error("[coding/workspaces/:id] Request failed", error);
  return NextResponse.json({ error: "Coding workspace storage failed." }, { status: 500 });
}

async function parseWorkspaceId(ctx: RouteContext): Promise<string | NextResponse> {
  const { workspaceId } = await ctx.params;
  const parsed = CodingWorkspaceIdSchema.safeParse(workspaceId);
  return parsed.success
    ? parsed.data
    : NextResponse.json({ error: "Invalid coding workspace id." }, { status: 400 });
}

export async function GET(_request: NextRequest, ctx: RouteContext) {
  const workspaceId = await parseWorkspaceId(ctx);
  if (workspaceId instanceof NextResponse) return workspaceId;
  try {
    const snapshot = await getCodingWorkspace(workspaceId);
    return snapshot
      ? NextResponse.json(snapshot, { headers: { "Cache-Control": "no-store, max-age=0" } })
      : NextResponse.json({ error: "Coding workspace not found." }, { status: 404 });
  } catch (error) {
    return storageErrorResponse(error);
  }
}

export async function DELETE(_request: NextRequest, ctx: RouteContext) {
  const workspaceId = await parseWorkspaceId(ctx);
  if (workspaceId instanceof NextResponse) return workspaceId;
  try {
    const deployments = await listCodingDeployments(workspaceId);
    const attachedApp = deployments.find((deployment) => (
      deployment.status !== "stopped"
      && (
        Boolean(deployment.appId)
        || deployment.status === "queued"
        || deployment.status === "building"
      )
    ));
    if (attachedApp) {
      return NextResponse.json(
        { error: "Cancel the deployment build or delete its DigitalOcean app before deleting this coding project." },
        { status: 409 },
      );
    }
    await deleteCodingWorkspace(workspaceId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return storageErrorResponse(error);
  }
}
