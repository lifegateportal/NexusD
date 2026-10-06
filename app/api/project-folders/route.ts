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

const ORGANIZATION_KEY = "project-organization/folders.json";
const PutOrganizationSchema = z.object({
  organization: ProjectOrganizationSchema,
}).strict();

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

export async function GET() {
  const r2 = makeS3();
  if (!r2) return NextResponse.json({ organization: null });

  try {
    const result = await r2.s3.send(new GetObjectCommand({ Bucket: r2.bucket, Key: ORGANIZATION_KEY }));
    const raw = await result.Body?.transformToString();
    if (!raw) return NextResponse.json({ organization: null });
    const parsed = ProjectOrganizationSchema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success
      ? NextResponse.json({ organization: createProjectOrganization(parsed.data.folders, parsed.data.updatedAt) })
      : NextResponse.json({ organization: null });
  } catch (error) {
    if (error instanceof Error && error.name === "NoSuchKey") {
      return NextResponse.json({ organization: null });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load project folders" },
      { status: 500 },
    );
  }
}

export async function PUT(req: NextRequest) {
  const r2 = makeS3();
  if (!r2) return NextResponse.json({ ok: true });

  let input: z.infer<typeof PutOrganizationSchema>;
  try {
    input = PutOrganizationSchema.parse(await req.json() as unknown);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid organization payload" },
      { status: 400 },
    );
  }

  const organization = createProjectOrganization(
    input.organization.folders,
    input.organization.updatedAt,
  );

  try {
    await r2.s3.send(new PutObjectCommand({
      Bucket: r2.bucket,
      Key: ORGANIZATION_KEY,
      Body: JSON.stringify(organization),
      ContentType: "application/json",
      CacheControl: "private, no-cache",
    }));
    return NextResponse.json({ ok: true, organization });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to save project folders" },
      { status: 500 },
    );
  }
}
