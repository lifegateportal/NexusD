import { NextRequest, NextResponse } from "next/server";
import { CodingDeploymentRequestSchema } from "@/lib/coding-deployment";
import { CodingDeploymentError, codingDeploymentConfigurationError, createCodingDeployment, listWorkspaceCodingDeployments } from "@/lib/coding-deployment-service";
import { CodingWorkspaceIdSchema } from "@/lib/coding-workspace";
import { CodingWorkspaceStorageError, getCodingWorkspace } from "@/lib/coding-workspace-storage";

export const runtime = "nodejs";
export const maxDuration = 30;

type RouteContext = { params: Promise<{ workspaceId: string }> };

function errorResponse(error: unknown) {
  if (error instanceof CodingDeploymentError || error instanceof CodingWorkspaceStorageError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error("[coding/deployments] Request failed", error);
  return NextResponse.json({ error: "DigitalOcean deployment request failed." }, { status: 500 });
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
  const unavailable = codingDeploymentConfigurationError();
  if (unavailable) return NextResponse.json({ error: unavailable }, { status: 503 });
  try {
    const deployments = await listWorkspaceCodingDeployments(workspaceId);
    return NextResponse.json({ deployments }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest, ctx: RouteContext) {
  const workspaceId = await parseWorkspaceId(ctx);
  if (workspaceId instanceof NextResponse) return workspaceId;
  const unavailable = codingDeploymentConfigurationError();
  if (unavailable) return NextResponse.json({ error: unavailable }, { status: 503 });

  const parsedInput = CodingDeploymentRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsedInput.success) {
    return NextResponse.json({ error: "Confirm the deployment and provide a valid saved revision." }, { status: 400 });
  }

  try {
    const snapshot = await getCodingWorkspace(workspaceId);
    if (!snapshot) return NextResponse.json({ error: "Coding workspace not found." }, { status: 404 });
    if (snapshot.workspace.currentRevisionId !== parsedInput.data.revisionId) {
      return NextResponse.json(
        { error: "Save the latest project changes before deploying." },
        { status: 409 },
      );
    }
    const deployment = await createCodingDeployment(snapshot);
    return NextResponse.json({ deployment }, {
      status: 202,
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
