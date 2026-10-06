import { NextRequest, NextResponse } from "next/server";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { env } from "@/lib/env";
import { z } from "zod";
import { SermonProjectRecordSchema } from "@/lib/sermon-project-store";

export const runtime    = "nodejs";
export const maxDuration = 30;
const DELETED_PREFIX = "project-deletions/";

function makeS3(accountId: string, accessKey: string, secretKey: string) {
  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  });
}

function r2Ready() {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME } = env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) return null;
  return {
    s3:     makeS3(R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY),
    bucket: R2_BUCKET_NAME,
  };
}

function noSuchObject(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as Error & { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return error.name === "NoSuchKey" || error.name === "NotFound" || status === 404;
}

function projectSummary(project: Record<string, unknown>) {
  const decodeObject = (value: unknown): Record<string, unknown> | null => {
    if (value && typeof value === "object") return value as Record<string, unknown>;
    if (typeof value !== "string") return null;
    try {
      const decoded = JSON.parse(value) as unknown;
      return decoded && typeof decoded === "object" ? decoded as Record<string, unknown> : null;
    } catch {
      return null;
    }
  };
  const jobState = decodeObject(project.ebookJobState);
  const manifest = decodeObject(project.ebookManifest);
  const chapters = Array.isArray(manifest?.chapters)
    ? manifest.chapters
    : Array.isArray(jobState?.chapters)
      ? jobState.chapters
      : [];
  const totalWordCount = typeof manifest?.totalWordCount === "number"
    ? manifest.totalWordCount
    : chapters.reduce((sum, chapter) => (
        sum + (
          chapter && typeof chapter === "object" && typeof chapter.totalWordCount === "number"
            ? chapter.totalWordCount
            : 0
        )
      ), 0);
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    folderId: project.folderId,
    publishedSlug: project.publishedSlug,
    coverImageUrl: project.coverImageUrl,
    authorImageUrl: project.authorImageUrl,
    hasAcademy: Boolean(project.academy),
    hasEbookContent: Boolean(manifest || jobState),
    ebookChapterCount: chapters.length,
    ebookTotalWordCount: totalWordCount,
    ebookStatus: typeof jobState?.status === "string" ? jobState.status : undefined,
    isSermon: "sermonAssistant" in project,
  };
}

// ── GET /api/projects — return all saved ProjectSnapshots from R2 ─────────────

export async function GET(req: NextRequest) {
  const searchParams = new URL(req.url).searchParams;
  const kind = searchParams.get("kind");
  const requestedId = searchParams.get("id");
  const summaryOnly = searchParams.get("summary") === "1";
  const r2 = r2Ready();
  if (!r2) {
    return kind === "sermon"
      ? NextResponse.json({ error: "Cloud sermon storage is not configured." }, { status: 503 })
      : NextResponse.json({ projects: [] });
  }

  try {
    if (requestedId) {
      if (!/^[A-Za-z0-9._-]+$/.test(requestedId)) {
        return NextResponse.json({ error: "Invalid project id." }, { status: 400 });
      }
      try {
        const result = await r2.s3.send(new GetObjectCommand({
          Bucket: r2.bucket,
          Key: `projects/${requestedId}.json`,
        }));
        const raw = await result.Body?.transformToString();
        if (!raw) return NextResponse.json({ error: "Project not found." }, { status: 404 });
        const project = JSON.parse(raw) as unknown;
        if (!project || typeof project !== "object") {
          return NextResponse.json({ error: "Project not found." }, { status: 404 });
        }
        return NextResponse.json({ project });
      } catch (error) {
        if (noSuchObject(error)) {
          return NextResponse.json({ error: "Project not found." }, { status: 404 });
        }
        throw error;
      }
    }

    // List all objects under projects/
    const [list, deletedList] = await Promise.all([
      r2.s3.send(
      new ListObjectsV2Command({ Bucket: r2.bucket, Prefix: "projects/" }),
      ),
      r2.s3.send(
        new ListObjectsV2Command({ Bucket: r2.bucket, Prefix: DELETED_PREFIX }),
      ),
    ]);
    const keys = (list.Contents ?? [])
      .map((o) => o.Key)
      .filter((k): k is string => !!k && k.endsWith(".json"));

    if (keys.length === 0) return NextResponse.json({ projects: [] });

    // Fetch all in parallel
    const settled = await Promise.allSettled(
      keys.map(async (key) => {
        const res = await r2.s3.send(new GetObjectCommand({ Bucket: r2.bucket, Key: key }));
        const raw = await res.Body?.transformToString();
        if (!raw) return null;
        return JSON.parse(raw) as unknown;
      }),
    );

    const projects = settled
      .filter((r): r is PromiseFulfilledResult<unknown> => r.status === "fulfilled" && r.value !== null)
      .map((r) => r.value);
    const deletedProjectIds = (deletedList.Contents ?? [])
      .map((object) => object.Key)
      .filter((key): key is string => !!key && key.startsWith(DELETED_PREFIX) && key.endsWith(".json"))
      .map((key) => key.slice(DELETED_PREFIX.length, -".json".length));
    const deletedIds = new Set(deletedProjectIds);

    const activeProjects = projects.filter((project): project is Record<string, unknown> => (
      !!project &&
      typeof project === "object" &&
      "id" in project &&
      typeof project.id === "string" &&
      !deletedIds.has(project.id)
    ));
    const filteredProjects = kind === "sermon"
      ? activeProjects.filter((project) => "sermonAssistant" in project)
      : kind === "projects"
        ? activeProjects.filter((project) => !("sermonAssistant" in project))
        : activeProjects;

    return NextResponse.json({
      projects: summaryOnly ? filteredProjects.map(projectSummary) : filteredProjects,
      deletedProjectIds,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load projects";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// ── POST /api/projects — upsert a single ProjectSnapshot ─────────────────────

const UpsertSchema = z.object({
  project: z.object({ id: z.string().min(1) }).passthrough(),
});

export async function POST(req: NextRequest) {
  const kind = new URL(req.url).searchParams.get("kind");
  const r2 = r2Ready();
  if (!r2) {
    return kind === "sermon"
      ? NextResponse.json({ error: "Cloud sermon storage is not configured." }, { status: 503 })
      : NextResponse.json({ ok: true });
  }

  let input;
  try {
    input = UpsertSchema.parse(await req.json() as unknown);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid input" },
      { status: 400 },
    );
  }

  let project: z.infer<typeof UpsertSchema>["project"];
  try {
    project = "sermonAssistant" in input.project
      ? SermonProjectRecordSchema.parse(input.project)
      : input.project;
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid sermon project" },
      { status: 400 },
    );
  }
  try {
    await r2.s3.send(
      new PutObjectCommand({
        Bucket:       r2.bucket,
        Key:          `projects/${project.id}.json`,
        Body:         JSON.stringify(project),
        ContentType:  "application/json",
        CacheControl: "private, no-cache",
      }),
    );
    await r2.s3.send(
      new DeleteObjectCommand({
        Bucket: r2.bucket,
        Key: `${DELETED_PREFIX}${project.id}.json`,
      }),
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Save failed" },
      { status: 500 },
    );
  }
}

// ── DELETE /api/projects — remove a project from R2 ──────────────────────────

const DeleteSchema = z.object({ id: z.string().min(1) });

export async function DELETE(req: NextRequest) {
  const kind = new URL(req.url).searchParams.get("kind");
  const r2 = r2Ready();
  if (!r2) {
    return kind === "sermon"
      ? NextResponse.json({ error: "Cloud sermon storage is not configured." }, { status: 503 })
      : NextResponse.json({ ok: true });
  }

  let input;
  try {
    input = DeleteSchema.parse(await req.json() as unknown);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid input" },
      { status: 400 },
    );
  }

  try {
    await r2.s3.send(
      new DeleteObjectCommand({ Bucket: r2.bucket, Key: `projects/${input.id}.json` }),
    );
    await r2.s3.send(
      new PutObjectCommand({
        Bucket: r2.bucket,
        Key: `${DELETED_PREFIX}${input.id}.json`,
        Body: JSON.stringify({ id: input.id, deletedAt: new Date().toISOString() }),
        ContentType: "application/json",
        CacheControl: "private, no-cache",
      }),
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Delete failed" },
      { status: 500 },
    );
  }
}
