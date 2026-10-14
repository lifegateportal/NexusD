import { NextRequest, NextResponse } from "next/server";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { z } from "zod";
import { env } from "@/lib/env";
import { AcademyProjectSchema } from "@/lib/schemas/academy-project";

export const runtime = "nodejs";
export const maxDuration = 30;

const PROJECT_PREFIX = "academy-projects/";
const DELETED_PREFIX = "academy-project-deletions/";

function storageConfig() {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME } = env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) return null;
  return {
    bucket: R2_BUCKET_NAME,
    s3: new S3Client({
      region: "auto",
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    }),
  };
}

function noSuchObject(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as Error & { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return error.name === "NoSuchKey" || error.name === "NotFound" || status === 404;
}

function summary(project: z.infer<typeof AcademyProjectSchema>) {
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    folderId: project.folderId,
    academyPublishedSlug: project.academyPublishedSlug,
    academyDraftVersion: project.academyDraftVersion,
    academyPublishedVersion: project.academyPublishedVersion,
    hasAcademy: true,
  };
}

export async function GET(request: NextRequest) {
  const storage = storageConfig();
  if (!storage) return NextResponse.json({ projects: [] });
  const requestedId = request.nextUrl.searchParams.get("id");
  const summaryOnly = request.nextUrl.searchParams.get("summary") === "1";

  try {
    if (requestedId) {
      if (!/^[A-Za-z0-9._-]+$/.test(requestedId)) {
        return NextResponse.json({ error: "Invalid Academy project id." }, { status: 400 });
      }
      try {
        const result = await storage.s3.send(new GetObjectCommand({
          Bucket: storage.bucket,
          Key: `${PROJECT_PREFIX}${requestedId}.json`,
        }));
        const raw = await result.Body?.transformToString();
        if (!raw) return NextResponse.json({ error: "Academy project not found." }, { status: 404 });
        const project = AcademyProjectSchema.parse(JSON.parse(raw));
        return NextResponse.json({ project });
      } catch (error) {
        if (noSuchObject(error)) return NextResponse.json({ error: "Academy project not found." }, { status: 404 });
        throw error;
      }
    }

    const [projectList, deletedList] = await Promise.all([
      storage.s3.send(new ListObjectsV2Command({ Bucket: storage.bucket, Prefix: PROJECT_PREFIX })),
      storage.s3.send(new ListObjectsV2Command({ Bucket: storage.bucket, Prefix: DELETED_PREFIX })),
    ]);
    const deletedIds = new Set(
      (deletedList.Contents ?? [])
        .map((object) => object.Key)
        .filter((key): key is string => !!key && key.startsWith(DELETED_PREFIX) && key.endsWith(".json"))
        .map((key) => key.slice(DELETED_PREFIX.length, -".json".length)),
    );
    const keys = (projectList.Contents ?? [])
      .map((object) => object.Key)
      .filter((key): key is string => !!key && key.startsWith(PROJECT_PREFIX) && key.endsWith(".json"));
    const settled = await Promise.allSettled(keys.map(async (key) => {
      const result = await storage.s3.send(new GetObjectCommand({ Bucket: storage.bucket, Key: key }));
      const raw = await result.Body?.transformToString();
      return raw ? AcademyProjectSchema.parse(JSON.parse(raw)) : null;
    }));
    const projects = settled
      .filter((result): result is PromiseFulfilledResult<z.infer<typeof AcademyProjectSchema>> => result.status === "fulfilled" && result.value !== null)
      .map((result) => result.value)
      .filter((project) => !deletedIds.has(project.id))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return NextResponse.json({
      projects: summaryOnly ? projects.map(summary) : projects,
      deletedProjectIds: Array.from(deletedIds),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load Academy projects." },
      { status: 500 },
    );
  }
}

const UpsertSchema = z.object({
  project: AcademyProjectSchema,
});

export async function POST(request: NextRequest) {
  const storage = storageConfig();
  if (!storage) return NextResponse.json({ error: "Academy project storage is not configured." }, { status: 503 });
  let input: z.infer<typeof UpsertSchema>;
  try {
    input = UpsertSchema.parse(await request.json() as unknown);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid Academy project." },
      { status: 400 },
    );
  }
  try {
    await storage.s3.send(new PutObjectCommand({
      Bucket: storage.bucket,
      Key: `${PROJECT_PREFIX}${input.project.id}.json`,
      Body: JSON.stringify(input.project),
      ContentType: "application/json",
      CacheControl: "private, no-cache",
    }));
    await storage.s3.send(new DeleteObjectCommand({
      Bucket: storage.bucket,
      Key: `${DELETED_PREFIX}${input.project.id}.json`,
    }));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not save Academy project." },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  let id: string;
  try {
    id = z.object({ id: z.string().regex(/^[A-Za-z0-9._-]+$/) }).parse(await request.json() as unknown).id;
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid Academy project id." },
      { status: 400 },
    );
  }
  const storage = storageConfig();
  if (!storage) return NextResponse.json({ error: "Academy project storage is not configured." }, { status: 503 });
  try {
    await storage.s3.send(new DeleteObjectCommand({
      Bucket: storage.bucket,
      Key: `${PROJECT_PREFIX}${id}.json`,
    }));
    await storage.s3.send(new PutObjectCommand({
      Bucket: storage.bucket,
      Key: `${DELETED_PREFIX}${id}.json`,
      Body: JSON.stringify({ id, deletedAt: new Date().toISOString() }),
      ContentType: "application/json",
      CacheControl: "private, no-cache",
    }));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not delete Academy project." },
      { status: 500 },
    );
  }
}
