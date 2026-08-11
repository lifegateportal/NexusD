import { NextRequest, NextResponse } from "next/server";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { env } from "@/lib/env";
import { EbookJobStateSchema } from "@/lib/schemas/ebook";

export const runtime = "nodejs";

function makeS3Client(accountId: string, accessKey: string, secretKey: string) {
  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  });
}

export async function POST(req: NextRequest, { params }: { params: { jobId: string } }) {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME } = env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
    return NextResponse.json({ error: "R2 not configured" }, { status: 503 });
  }

  try {
    const s3 = makeS3Client(R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY);
    const body = await req.json();
    const parsed = EbookJobStateSchema.parse(body);

    await s3.send(new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: `jobs/${params.jobId}.json`,
      Body: JSON.stringify(parsed),
      ContentType: "application/json"
    }));

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function GET(req: NextRequest, { params }: { params: { jobId: string } }) {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME } = env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
    return NextResponse.json({ error: "R2 not configured" }, { status: 503 });
  }

  try {
    const s3 = makeS3Client(R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY);
    const res = await s3.send(new GetObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: `jobs/${params.jobId}.json`
    }));
    const raw = await res.Body?.transformToString();
    if (!raw) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const parsed = EbookJobStateSchema.parse(JSON.parse(raw));
    
    return NextResponse.json(parsed);
  } catch (err: any) {
    return NextResponse.json({ error: "Not found", internal: err.message }, { status: 404 });
  }
}
