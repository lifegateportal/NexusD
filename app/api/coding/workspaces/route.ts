import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  CreateCodingWorkspaceSchema,
  CodingWorkspaceSchema,
} from "@/lib/coding-workspace";
import {
  createCodingWorkspace,
  listCodingWorkspaces,
  CodingWorkspaceStorageError,
} from "@/lib/coding-workspace-storage";

export const runtime = "nodejs";
export const maxDuration = 30;

function storageErrorResponse(error: unknown) {
  if (error instanceof CodingWorkspaceStorageError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error("[coding/workspaces] Request failed", error);
  return NextResponse.json({ error: "Coding workspace storage failed." }, { status: 500 });
}

export async function GET() {
  try {
    return NextResponse.json({ workspaces: await listCodingWorkspaces() }, {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch (error) {
    return storageErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  let input: z.infer<typeof CreateCodingWorkspaceSchema>;
  try {
    input = CreateCodingWorkspaceSchema.parse(await request.json() as unknown);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof z.ZodError ? error.issues : "Invalid coding workspace request." },
      { status: 400 },
    );
  }

  try {
    const snapshot = await createCodingWorkspace(input.name, input.files);
    CodingWorkspaceSchema.parse(snapshot.workspace);
    return NextResponse.json(snapshot, { status: 201 });
  } catch (error) {
    return storageErrorResponse(error);
  }
}
