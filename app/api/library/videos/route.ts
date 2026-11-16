import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { makeR2Client } from "@/lib/r2-storage";
import {
  LibraryVideoCatalogSchema,
  LibraryVideoRecordSchema,
  LibraryVideoSegmentSchema,
} from "@/lib/schemas/library-video";

export const runtime = "nodejs";
export const maxDuration = 30;

const VideoInputSchema = z.object({
  url: z.string().url().max(2000),
  title: z.string().trim().min(1).max(200),
  segments: z.array(LibraryVideoSegmentSchema).min(1).max(20000),
}).strict();

const VideoIdSchema = z.string().regex(/^[A-Za-z0-9_-]{11}$/);

function isMissingObject(error: unknown): boolean {
  return error instanceof Error && ["NoSuchKey", "NotFound"].includes(error.name);
}

function videoIdFromUrl(input: string): string | null {
  try {
    const url = new URL(input);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    let id: string | null = null;
    if (hostname === "youtu.be") id = url.pathname.split("/").filter(Boolean)[0] ?? null;
    if (hostname === "youtube.com" || hostname === "m.youtube.com") {
      id = url.searchParams.get("v")
        ?? url.pathname.match(/^\/(?:embed|shorts)\/([A-Za-z0-9_-]{11})/)?.[1]
        ?? null;
    }
    return id && VideoIdSchema.safeParse(id).success ? id : null;
  } catch {
    return null;
  }
}

async function readCatalog() {
  if (!env.R2_BUCKET_NAME) throw new Error("R2 bucket is not configured.");
  try {
    const result = await makeR2Client().send(new GetObjectCommand({
      Bucket: env.R2_BUCKET_NAME,
      Key: "published/videos/index.json",
    }));
    const body = await result.Body?.transformToString();
    if (!body) throw new Error("The video catalog in R2 is empty.");
    return {
      catalog: LibraryVideoCatalogSchema.parse(JSON.parse(body)),
      etag: result.ETag,
    };
  } catch (error) {
    if (isMissingObject(error)) {
      return {
        catalog: { updatedAt: new Date().toISOString(), videos: [] },
        etag: undefined,
      };
    }
    throw error;
  }
}

export async function GET() {
  const emptyCatalog = { updatedAt: new Date().toISOString(), videos: [] };
  if (!env.R2_PUBLIC_URL) return NextResponse.json(emptyCatalog);
  try {
    const response = await fetch(
      `${env.R2_PUBLIC_URL.replace(/\/$/, "")}/published/videos/index.json`,
      { next: { revalidate: 60 } },
    );
    if (response.status === 404) return NextResponse.json(emptyCatalog);
    if (!response.ok) {
      return NextResponse.json({ error: "Could not load the video library." }, { status: 502 });
    }
    const parsed = LibraryVideoCatalogSchema.safeParse(await response.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "The published video catalog is invalid." }, { status: 502 });
    }
    return NextResponse.json(parsed.data);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not load the video library." },
      { status: 502 },
    );
  }
}

export async function POST(request: NextRequest) {
  let input: z.infer<typeof VideoInputSchema>;
  try {
    input = VideoInputSchema.parse(await request.json() as unknown);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid video source." },
      { status: 400 },
    );
  }

  const videoId = videoIdFromUrl(input.url);
  if (!videoId) {
    return NextResponse.json({ error: "Enter a valid YouTube video URL." }, { status: 400 });
  }
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_BUCKET_NAME) {
    return NextResponse.json({ error: "R2 storage must be configured to save video sources." }, { status: 503 });
  }

  const now = new Date().toISOString();
  const record = LibraryVideoRecordSchema.parse({
    videoId,
    title: input.title,
    youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`,
    addedAt: now,
    segments: input.segments,
  });
  const s3 = makeR2Client();

  try {
    await s3.send(new PutObjectCommand({
      Bucket: env.R2_BUCKET_NAME,
      Key: `published/videos/${videoId}.json`,
      Body: JSON.stringify(record),
      ContentType: "application/json",
      CacheControl: "public, max-age=60",
    }));

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { catalog, etag } = await readCatalog();
      const updated = LibraryVideoCatalogSchema.parse({
        updatedAt: now,
        videos: [
          record,
          ...catalog.videos.filter((video) => video.videoId !== videoId),
        ],
      });
      try {
        await s3.send(new PutObjectCommand({
          Bucket: env.R2_BUCKET_NAME,
          Key: "published/videos/index.json",
          Body: JSON.stringify(updated),
          ContentType: "application/json",
          CacheControl: "public, max-age=30",
          IfMatch: etag,
        }));
        return NextResponse.json({ video: LibraryVideoCatalogSchema.shape.videos.element.parse(record) });
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "PreconditionFailed" || attempt === 2) throw error;
      }
    }
    throw new Error("Could not update the video catalog after concurrent changes.");
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not save this video source." },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  let videoId: string;
  try {
    const body = z.object({ videoId: VideoIdSchema }).strict().parse(await request.json() as unknown);
    videoId = body.videoId;
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid video source." },
      { status: 400 },
    );
  }
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_BUCKET_NAME) {
    return NextResponse.json({ error: "R2 storage must be configured to manage video sources." }, { status: 503 });
  }

  const s3 = makeR2Client();
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { catalog, etag } = await readCatalog();
      const updated = LibraryVideoCatalogSchema.parse({
        updatedAt: new Date().toISOString(),
        videos: catalog.videos.filter((video) => video.videoId !== videoId),
      });
      try {
        await s3.send(new PutObjectCommand({
          Bucket: env.R2_BUCKET_NAME,
          Key: "published/videos/index.json",
          Body: JSON.stringify(updated),
          ContentType: "application/json",
          CacheControl: "public, max-age=30",
          IfMatch: etag,
        }));
        await s3.send(new DeleteObjectCommand({
          Bucket: env.R2_BUCKET_NAME,
          Key: `published/videos/${videoId}.json`,
        }));
        return NextResponse.json({ videoId });
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "PreconditionFailed" || attempt === 2) throw error;
      }
    }
    throw new Error("Could not update the video catalog after concurrent changes.");
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not remove this video source." },
      { status: 500 },
    );
  }
}
