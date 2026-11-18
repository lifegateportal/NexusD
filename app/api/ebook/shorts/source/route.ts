import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";

export const runtime = "nodejs";

const RequestSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  contentType: z.enum([
    "video/mp4",
    "video/webm",
    "audio/mpeg",
    "audio/mp4",
    "audio/aac",
    "audio/wav",
    "audio/x-wav",
    "image/png",
    "image/jpeg",
    "image/webp",
  ]),
  size: z.number().int().min(1).max(500 * 1024 * 1024),
}).strict().refine(
  (input) => !input.contentType.startsWith("image/") || input.size <= 10 * 1024 * 1024,
  { message: "Images must be 10 MB or smaller.", path: ["size"] },
).refine(
  (input) => !input.contentType.startsWith("audio/") || input.size <= 100 * 1024 * 1024,
  { message: "Instrumental audio files must be 100 MB or smaller.", path: ["size"] },
);

export async function POST(request: NextRequest) {
  if (!process.env.AUTH_PASSWORD || !process.env.AUTH_COOKIE_SECRET) {
    return NextResponse.json({ error: "Configure Director authentication before uploading Shorts assets." }, { status: 503 });
  }
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_BUCKET_NAME || !env.R2_PUBLIC_URL) {
    return NextResponse.json(
      { error: "Configure Cloudflare R2 credentials, bucket, and public URL before publishing Shorts assets." },
      { status: 503 },
    );
  }

  let input: z.infer<typeof RequestSchema>;
  try {
    input = RequestSchema.parse(await request.json() as unknown);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid video upload request." },
      { status: 400 },
    );
  }

  try {
    const extensionByType = {
      "video/mp4": "mp4",
      "video/webm": "webm",
      "audio/mpeg": "mp3",
      "audio/mp4": "m4a",
      "audio/aac": "aac",
      "audio/wav": "wav",
      "audio/x-wav": "wav",
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/webp": "webp",
    } as const;
    const extension = extensionByType[input.contentType];
    const key = `published/shorts/assets/${crypto.randomUUID()}.${extension}`;
    const client = new S3Client({
      region: "auto",
      endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
    });
    const presignedUrl = await getSignedUrl(client, new PutObjectCommand({
      Bucket: env.R2_BUCKET_NAME,
      Key: key,
      ContentType: input.contentType,
    }), { expiresIn: 3600 });
    return NextResponse.json({
      presignedUrl,
      sourceUrl: `${env.R2_PUBLIC_URL.replace(/\/$/, "")}/${key}`,
      contentType: input.contentType,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not prepare the video upload." },
      { status: 500 },
    );
  }
}
