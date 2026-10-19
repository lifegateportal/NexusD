import { NextRequest, NextResponse } from "next/server";
import {
  CodingDeploymentError,
  codingDeploymentConfigurationError,
  deployCodingStaticArtifact,
  withCodingStaticArtifactRequest,
} from "@/lib/coding-deployment-service";
import { CodingRevisionIdSchema, CodingWorkspaceIdSchema } from "@/lib/coding-workspace";
import { CodingWorkspaceStorageError, getCodingWorkspace } from "@/lib/coding-workspace-storage";
import { MAX_CODING_STATIC_ARCHIVE_BYTES } from "@/lib/coding-static-artifact";

export const runtime = "nodejs";
export const maxDuration = 360;

type RouteContext = { params: Promise<{ workspaceId: string }> };

function errorResponse(error: unknown) {
  if (error instanceof CodingDeploymentError) {
    return NextResponse.json({
      error: error.message,
      ...(error.deployment ? { deployment: error.deployment } : {}),
    }, { status: error.status });
  }
  if (error instanceof CodingWorkspaceStorageError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error("[coding/deployments/static] Request failed", error);
  return NextResponse.json({ error: "Static site deployment failed." }, { status: 500 });
}

async function readArtifact(request: NextRequest): Promise<Uint8Array | NextResponse> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/zip") {
    return NextResponse.json({ error: "Upload the browser-built static site as a ZIP archive." }, { status: 415 });
  }
  const contentEncoding = request.headers.get("content-encoding");
  if (contentEncoding && contentEncoding !== "identity") {
    return NextResponse.json({ error: "Compressed HTTP request bodies are not supported." }, { status: 415 });
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && !/^\d{1,12}$/.test(declaredLength)) {
    return NextResponse.json({ error: "The static artifact size is invalid." }, { status: 400 });
  }
  if (declaredLength !== null && Number(declaredLength) > MAX_CODING_STATIC_ARCHIVE_BYTES) {
    return NextResponse.json({ error: "The built static ZIP must be smaller than 25 MB." }, { status: 413 });
  }
  if (!request.body) {
    return NextResponse.json({ error: "The static artifact upload is empty." }, { status: 400 });
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (totalBytes > MAX_CODING_STATIC_ARCHIVE_BYTES) {
        await reader.cancel();
        return NextResponse.json({ error: "The built static ZIP must be smaller than 25 MB." }, { status: 413 });
      }
      if (chunks.length >= 2_048) {
        await reader.cancel();
        return NextResponse.json({ error: "The static artifact upload contains too many chunks." }, { status: 413 });
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (error instanceof Error) throw error;
    return NextResponse.json({ error: "The static artifact upload could not be read." }, { status: 400 });
  } finally {
    reader.releaseLock();
  }
  if (declaredLength !== null && Number(declaredLength) !== totalBytes) {
    return NextResponse.json({ error: "The static artifact size did not match the upload." }, { status: 400 });
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function POST(request: NextRequest, ctx: RouteContext) {
  const { workspaceId: rawWorkspaceId } = await ctx.params;
  const workspaceId = CodingWorkspaceIdSchema.safeParse(rawWorkspaceId);
  if (!workspaceId.success) {
    return NextResponse.json({ error: "Invalid coding workspace id." }, { status: 400 });
  }
  const unavailable = codingDeploymentConfigurationError("static");
  if (unavailable) return NextResponse.json({ error: unavailable }, { status: 503 });
  const revisionId = CodingRevisionIdSchema.safeParse(request.headers.get("x-coding-revision-id"));
  if (!revisionId.success) {
    return NextResponse.json({ error: "A valid saved revision is required for static deployment." }, { status: 400 });
  }
  return withCodingStaticArtifactRequest(async () => {
    try {
      const artifact = await readArtifact(request);
      if (artifact instanceof NextResponse) return artifact;
      const snapshot = await getCodingWorkspace(workspaceId.data);
      if (!snapshot) return NextResponse.json({ error: "Coding workspace not found." }, { status: 404 });
      if (snapshot.workspace.currentRevisionId !== revisionId.data) {
        return NextResponse.json({ error: "Save the latest project changes before deploying." }, { status: 409 });
      }
      const deployment = await deployCodingStaticArtifact(snapshot, artifact);
      return NextResponse.json({ deployment }, {
        status: 201,
        headers: { "Cache-Control": "no-store, max-age=0" },
      });
    } catch (error) {
      return errorResponse(error);
    }
  });
}
