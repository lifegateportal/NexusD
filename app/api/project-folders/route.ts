import { NextRequest, NextResponse } from "next/server";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { z } from "zod";
import { env } from "@/lib/env";
import {
  ProjectOrganizationSchema,
  createProjectOrganization,
} from "@/lib/project-organization-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OrganizationScopeSchema = z.enum(["projects", "sermons"]);
const ORGANIZATION_KEYS = {
  projects: "project-organization/folders.json",
  sermons: "sermon-organization/folders.json",
} as const;
const PutOrganizationSchema = z.object({
  organization: ProjectOrganizationSchema,
}).strict();

function parseScope(value: string | null) {
  const parsed = OrganizationScopeSchema.safeParse(value ?? "projects");
  return parsed.success ? parsed.data : null;
}

function makeS3() {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME } = env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) return null;
  return {
    s3: new S3Client({
      region: "auto",
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    }),
    bucket: R2_BUCKET_NAME,
  };
}

function noSuchObject(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as Error & { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return error.name === "NoSuchKey" || error.name === "NotFound" || status === 404;
}

function jsonNoStore(body: unknown, init?: ResponseInit) {
  return NextResponse.json(body, {
    ...init,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      ...(init?.headers ?? {}),
    },
  });
}

export async function GET(req: NextRequest) {
  const scope = parseScope(req.nextUrl.searchParams.get("scope"));
  if (!scope) {
    return jsonNoStore({ error: "Invalid folder organization scope." }, { status: 400 });
  }
  const organizationKey = ORGANIZATION_KEYS[scope];
  const r2 = makeS3();
  if (!r2) {
    return jsonNoStore(
      { error: "Cloud folder storage is not configured." },
      { status: 503 },
    );
  }

  try {
    const result = await r2.s3.send(new GetObjectCommand({ Bucket: r2.bucket, Key: organizationKey }));
    const raw = await result.Body?.transformToString();
    if (!raw) return jsonNoStore({ organization: null });
    const parsed = ProjectOrganizationSchema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success
      ? jsonNoStore({ organization: createProjectOrganization(parsed.data.folders, parsed.data.updatedAt) })
      : jsonNoStore({ organization: null });
  } catch (error) {
    if (noSuchObject(error)) {
      return jsonNoStore({ organization: null });
    }
    return jsonNoStore(
      { error: error instanceof Error ? error.message : "Failed to load project folders" },
      { status: 500 },
    );
  }
}

export async function PUT(req: NextRequest) {
  const scope = parseScope(req.nextUrl.searchParams.get("scope"));
  if (!scope) {
    return jsonNoStore({ error: "Invalid folder organization scope." }, { status: 400 });
  }
  const organizationKey = ORGANIZATION_KEYS[scope];
  const r2 = makeS3();
  if (!r2) {
    return jsonNoStore(
      { error: "Cloud folder storage is not configured." },
      { status: 503 },
    );
  }

  let input: z.infer<typeof PutOrganizationSchema>;
  try {
    input = PutOrganizationSchema.parse(await req.json() as unknown);
  } catch (error) {
    return jsonNoStore(
      { error: error instanceof Error ? error.message : "Invalid organization payload" },
      { status: 400 },
    );
  }

  const organization = createProjectOrganization(
    input.organization.folders,
    input.organization.updatedAt,
  );

  try {
    let currentOrganization: ReturnType<typeof createProjectOrganization> | null = null;
    try {
      const current = await r2.s3.send(new GetObjectCommand({ Bucket: r2.bucket, Key: organizationKey }));
      const raw = await current.Body?.transformToString();
      if (raw) {
        const parsed = ProjectOrganizationSchema.safeParse(JSON.parse(raw) as unknown);
        if (parsed.success) {
          currentOrganization = createProjectOrganization(parsed.data.folders, parsed.data.updatedAt);
        }
      }
    } catch (error) {
      if (!noSuchObject(error)) throw error;
    }

    if (
      currentOrganization &&
      new Date(currentOrganization.updatedAt).getTime() > new Date(organization.updatedAt).getTime()
    ) {
      return jsonNoStore({ ok: true, organization: currentOrganization });
    }

    await r2.s3.send(new PutObjectCommand({
      Bucket: r2.bucket,
      Key: organizationKey,
      Body: JSON.stringify(organization),
      ContentType: "application/json",
      CacheControl: "private, no-cache",
    }));
    return jsonNoStore({ ok: true, organization });
  } catch (error) {
    return jsonNoStore(
      { error: error instanceof Error ? error.message : "Failed to save project folders" },
      { status: 500 },
    );
  }
}
