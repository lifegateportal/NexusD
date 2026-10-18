import { NextRequest, NextResponse } from "next/server";
import { CodingDeploymentDeleteRequestSchema, CodingDeploymentIdSchema } from "@/lib/coding-deployment";
import {
  CodingDeploymentError,
  codingDeploymentConfigurationError,
  refreshCodingDeployment,
  stopCodingDeployment,
} from "@/lib/coding-deployment-service";
import { CodingWorkspaceIdSchema } from "@/lib/coding-workspace";
import { CodingWorkspaceStorageError } from "@/lib/coding-workspace-storage";

export const runtime = "nodejs";
export const maxDuration = 30;

type RouteContext = { params: Promise<{ workspaceId: string; deploymentId: string }> };

function errorResponse(error: unknown) {
  if (error instanceof CodingDeploymentError || error instanceof CodingWorkspaceStorageError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error("[coding/deployments/:id] Request failed", error);
  return NextResponse.json({ error: "Project deployment request failed." }, { status: 500 });
}

async function parseIdentifiers(ctx: RouteContext) {
  const { workspaceId, deploymentId } = await ctx.params;
  const parsedWorkspaceId = CodingWorkspaceIdSchema.safeParse(workspaceId);
  const parsedDeploymentId = CodingDeploymentIdSchema.safeParse(deploymentId);
  if (!parsedWorkspaceId.success || !parsedDeploymentId.success) {
    return NextResponse.json({ error: "Invalid coding deployment identifier." }, { status: 400 });
  }
  return { workspaceId: parsedWorkspaceId.data, deploymentId: parsedDeploymentId.data };
}

export async function GET(_request: NextRequest, ctx: RouteContext) {
  const identifiers = await parseIdentifiers(ctx);
  if (identifiers instanceof NextResponse) return identifiers;
  const unavailable = codingDeploymentConfigurationError();
  if (unavailable) return NextResponse.json({ error: unavailable }, { status: 503 });
  try {
    const deployment = await refreshCodingDeployment(identifiers.workspaceId, identifiers.deploymentId);
    return deployment
      ? NextResponse.json({ deployment }, { headers: { "Cache-Control": "no-store, max-age=0" } })
      : NextResponse.json({ error: "Coding deployment not found." }, { status: 404 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: NextRequest, ctx: RouteContext) {
  const identifiers = await parseIdentifiers(ctx);
  if (identifiers instanceof NextResponse) return identifiers;
  const unavailable = codingDeploymentConfigurationError();
  if (unavailable) return NextResponse.json({ error: unavailable }, { status: 503 });
  const confirmation = CodingDeploymentDeleteRequestSchema.safeParse(await request.json().catch(() => null));
  if (!confirmation.success || confirmation.data.confirmDeletion !== true) {
    return NextResponse.json({ error: "Confirm taking the deployed site offline." }, { status: 400 });
  }
  try {
    const deployment = await stopCodingDeployment(identifiers.workspaceId, identifiers.deploymentId);
    return deployment
      ? NextResponse.json({ deployment }, { headers: { "Cache-Control": "no-store, max-age=0" } })
      : NextResponse.json({ error: "Coding deployment not found." }, { status: 404 });
  } catch (error) {
    return errorResponse(error);
  }
}
