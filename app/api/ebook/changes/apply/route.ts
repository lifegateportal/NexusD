import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  EbookManifestSchema,
} from "@/lib/schemas/ebook";
import {
  applySelectedManifestChanges,
  buildManifestChangeEntries,
} from "@/lib/ebook-change-control";
import { computeEbookManifestVersion } from "@/lib/ebook-manifest-version";

export const runtime = "nodejs";
export const maxDuration = 30;

const RequestSchema = z.object({
  manifest: EbookManifestSchema,
  proposedManifest: EbookManifestSchema,
  selectedPaths: z.array(z.string().min(1).max(160)).min(1).max(200),
  manifestVersion: z.string().min(1).max(64),
  instruction: z.string().min(1).max(4000),
  summary: z.string().min(1).max(1000),
});

export async function POST(req: NextRequest) {
  let input: z.infer<typeof RequestSchema>;
  try {
    input = RequestSchema.parse(await req.json() as unknown);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid change request" },
      { status: 400 }
    );
  }

  const currentVersion = computeEbookManifestVersion(input.manifest);
  if (input.manifestVersion !== currentVersion) {
    return NextResponse.json(
      {
        error: "Conflict: the book changed while this proposal was open. Generate a new preview before applying it.",
        code: "VERSION_CONFLICT",
      },
      { status: 409 }
    );
  }

  const validPaths = new Set(
    buildManifestChangeEntries(input.manifest, input.proposedManifest).map((entry) => entry.path)
  );
  const invalidPaths = input.selectedPaths.filter((path) => !validPaths.has(path));
  if (invalidPaths.length > 0) {
    return NextResponse.json(
      { error: `Selected changes are no longer valid: ${invalidPaths.join(", ")}` },
      { status: 422 }
    );
  }

  const selectedManifest = applySelectedManifestChanges(
    input.manifest,
    input.proposedManifest,
    input.selectedPaths
  );
  const chapters = selectedManifest.chapters.map((chapter) => {
    const sections = chapter.sections.map((section) => ({
      ...section,
      wordCount: section.body.trim().split(/\s+/).filter(Boolean).length,
    }));
    return {
      ...chapter,
      sections,
      totalWordCount: sections.reduce((sum, section) => sum + section.wordCount, 0),
    };
  });
  const existingLog = input.manifest.changeLog ?? [];
  const normalizedManifest = {
    ...selectedManifest,
    chapters,
    totalWordCount: chapters.reduce(
      (sum, chapter) => sum + chapter.totalWordCount,
      0
    ),
    changeLog: [
      ...existingLog,
      {
        timestamp: new Date().toISOString(),
        instruction: input.instruction.slice(0, 200),
        summary: input.summary,
        model: "v3" as const,
      },
    ].slice(-50),
  };
  const parsed = EbookManifestSchema.safeParse(normalizedManifest);
  if (!parsed.success) {
    return NextResponse.json(
      { error: `Manifest validation failed: ${parsed.error.issues[0]?.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({
    manifest: parsed.data,
    summary: input.summary,
    appliedPaths: input.selectedPaths,
    manifestVersion: computeEbookManifestVersion(parsed.data),
  });
}
