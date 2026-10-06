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

// ── GET /api/projects — return all saved ProjectSnapshots from R2 ─────────────

export async function GET(req: NextRequest) {
  const kind = new URL(req.url).searchParams.get("kind");
  const r2 = r2Ready();
  if (!r2) {
    return kind === "sermon"
      ? NextResponse.json({ error: "Cloud sermon storage is not configured." }, { status: 503 })
      : NextResponse.json({ projects: [] });
  }

  try {
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

    const activeProjects = projects.filter((project) => {
        if (!project || typeof project !== "object" || !("id" in project)) return true;
        return typeof project.id !== "string" || !deletedIds.has(project.id);
      });
    const filteredProjects = kind === "sermon"
      ? activeProjects.filter((project) => (
          !!project &&
          typeof project === "object" &&
          "sermonAssistant" in project
        ))
      : activeProjects;

    return NextResponse.json({
      projects: filteredProjects,
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
