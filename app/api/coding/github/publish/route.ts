import { NextRequest, NextResponse } from "next/server";
import {
  CodingGitHubError,
  decryptGitHubToken,
  GITHUB_SESSION_COOKIE,
  publishCodingWorkspaceToGitHub,
} from "@/lib/coding-github";
import { CodingGitHubPublishRequestSchema } from "@/lib/coding-github-schema";
import { CodingWorkspaceStorageError } from "@/lib/coding-workspace-storage";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: NextRequest) {
  const parsed = CodingGitHubPublishRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid GitHub publishing request." }, { status: 400 });
  }
  try {
    const token = decryptGitHubToken(request.cookies.get(GITHUB_SESSION_COOKIE)?.value);
    const result = await publishCodingWorkspaceToGitHub(token, parsed.data);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (error) {
    if (error instanceof CodingGitHubError || error instanceof CodingWorkspaceStorageError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[coding/github/publish] Failed to publish coding workspace", error);
    return NextResponse.json({ error: "GitHub publishing failed. No success was reported." }, { status: 500 });
  }
}
