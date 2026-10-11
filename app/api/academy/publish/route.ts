import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { z } from "zod";
import { env } from "@/lib/env";
import {
  PublishedAcademyCatalogSchema,
  PublishedAcademyEntrySchema,
  PublishedAcademyManifestSchema,
} from "@/lib/schemas/published-academy";
import { AcademyPackageSchema } from "@/lib/schemas/academy";
import { SiteConfigSchema } from "@/lib/schemas/site-config";
import { enforceAcademyMediaCapabilities, normalizeAcademyLearnerVoice } from "@/lib/academy-content";

export const runtime = "nodejs";
export const maxDuration = 30;

const CATALOG_KEY = "academy-published/index.json";

function makeS3Client(accountId: string, accessKey: string, secretKey: string) {
  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  });
}

function noSuchObject(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as Error & { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return error.name === "NoSuchKey" || error.name === "NotFound" || status === 404;
}

function storageConfig() {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME } = env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) return null;
  return {
    bucket: R2_BUCKET_NAME,
    s3: makeS3Client(R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY),
  };
}

async function readCatalog(
  s3: S3Client,
  bucket: string,
): Promise<{ catalog: z.infer<typeof PublishedAcademyCatalogSchema>; etag?: string }> {
  try {
    const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: CATALOG_KEY }));
    const raw = await result.Body?.transformToString();
    if (!raw) return { catalog: { updatedAt: new Date().toISOString(), courses: [] } };
    const parsed = PublishedAcademyCatalogSchema.safeParse(JSON.parse(raw));
    return {
      catalog: parsed.success
        ? parsed.data
        : { updatedAt: new Date().toISOString(), courses: [] },
      etag: result.ETag,
    };
  } catch (error) {
    if (noSuchObject(error)) {
      return { catalog: { updatedAt: new Date().toISOString(), courses: [] } };
    }
    throw error;
  }
}

function slugify(title: string, projectId: string): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "academy";
  const suffix = projectId.replace(/[^a-z0-9]/gi, "").slice(-6) || Date.now().toString(36).slice(-6);
  return `${base}-${suffix}`;
}

function accentForTheme(theme: string): "cyan" | "amber" | "emerald" | "rose" | "violet" | "slate" {
  if (theme === "amber" || theme === "emerald" || theme === "rose" || theme === "violet") return theme;
  if (theme === "solar") return "amber";
  return theme === "midnight" ? "slate" : "cyan";
}

export async function GET() {
  const storage = storageConfig();
  if (!storage) return NextResponse.json({ courses: [] });
  try {
    const { catalog } = await readCatalog(storage.s3, storage.bucket);
    return NextResponse.json(catalog);
  } catch {
    return NextResponse.json({ courses: [] });
  }
}

const PublishRequestSchema = z.object({
  projectId: z.string().min(1).optional(),
  existingSlug: z.string().regex(/^[a-z0-9-]+$/).optional(),
  academy: AcademyPackageSchema,
  siteConfig: SiteConfigSchema.default({}),
});

export async function POST(req: NextRequest) {
  let input: z.infer<typeof PublishRequestSchema>;
  try {
    input = PublishRequestSchema.parse(await req.json() as unknown);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid Academy publish request." },
      { status: 400 },
    );
  }

  const storage = storageConfig();
  if (!storage) {
    return NextResponse.json(
      { error: "R2 storage must be configured to publish Academy courses." },
      { status: 503 },
    );
  }

  const hasVideoSource = input.academy.sourceCapabilities.hasVideo
    || input.academy.curriculum.some((module) => module.lessons.some((lesson) => lesson.type === "video"));
  const academy = normalizeAcademyLearnerVoice(
    enforceAcademyMediaCapabilities(input.academy, hasVideoSource),
  );
  const siteConfig = SiteConfigSchema.parse(input.siteConfig);
  let slug = input.existingSlug ?? slugify(academy.academyName, input.projectId ?? academy.academyName);

  try {
    const initial = await readCatalog(storage.s3, storage.bucket);
    const baseSlug = slug;
    let counter = 1;
    while (initial.catalog.courses.some((course) => course.slug === slug && course.slug !== input.existingSlug)) {
      counter++;
      slug = `${baseSlug}-${counter}`;
    }

    const manifest = PublishedAcademyManifestSchema.parse({ academy, siteConfig });
    await storage.s3.send(new PutObjectCommand({
      Bucket: storage.bucket,
      Key: `academy-published/${slug}/manifest.json`,
      Body: JSON.stringify(manifest),
      ContentType: "application/json",
      CacheControl: "public, max-age=60",
    }));

    const now = new Date().toISOString();
    const entry = PublishedAcademyEntrySchema.parse({
      slug,
      academyName: academy.academyName,
      tagline: academy.tagline,
      targetAudience: academy.targetAudience,
      publishedAt: now,
      updatedAt: now,
      moduleCount: academy.curriculum.length,
      lessonCount: academy.curriculum.reduce((sum, module) => sum + module.lessons.length, 0),
      totalEstimatedHours: academy.totalEstimatedHours,
      difficultyLevel: academy.difficultyLevel,
      themeVariant: academy.themeVariant,
      accent: accentForTheme(academy.themeVariant),
    });

    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await readCatalog(storage.s3, storage.bucket);
      const catalog = {
        ...current.catalog,
        updatedAt: now,
        courses: [entry, ...current.catalog.courses.filter((course) => course.slug !== slug)],
      };
      try {
        await storage.s3.send(new PutObjectCommand({
          Bucket: storage.bucket,
          Key: CATALOG_KEY,
          Body: JSON.stringify(catalog),
          ContentType: "application/json",
          CacheControl: "public, max-age=30",
          IfMatch: current.etag,
        }));
        break;
      } catch (error) {
        if (error instanceof Error && error.name === "PreconditionFailed" && attempt < 2) continue;
        throw error;
      }
    }

    revalidatePath("/academy");
    return NextResponse.json({
      slug,
      publicUrl: env.R2_PUBLIC_URL
        ? `${env.R2_PUBLIC_URL.replace(/\/$/, "")}/academy-published/${slug}/manifest.json`
        : null,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Academy publish failed." },
      { status: 500 },
    );
  }
}

export async function DELETE(req: NextRequest) {
  let slug: string;
  try {
    const parsed = z.object({ slug: z.string().regex(/^[a-z0-9-]+$/) }).parse(await req.json() as unknown);
    slug = parsed.slug;
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid Academy slug." },
      { status: 400 },
    );
  }

  const storage = storageConfig();
  if (!storage) return NextResponse.json({ error: "R2 storage is not configured." }, { status: 503 });

  try {
    await storage.s3.send(new DeleteObjectCommand({
      Bucket: storage.bucket,
      Key: `academy-published/${slug}/manifest.json`,
    }));
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await readCatalog(storage.s3, storage.bucket);
      const catalog = {
        ...current.catalog,
        updatedAt: new Date().toISOString(),
        courses: current.catalog.courses.filter((course) => course.slug !== slug),
      };
      try {
        await storage.s3.send(new PutObjectCommand({
          Bucket: storage.bucket,
          Key: CATALOG_KEY,
          Body: JSON.stringify(catalog),
          ContentType: "application/json",
          CacheControl: "public, max-age=30",
          IfMatch: current.etag,
        }));
        break;
      } catch (error) {
        if (error instanceof Error && error.name === "PreconditionFailed" && attempt < 2) continue;
        throw error;
      }
    }
    revalidatePath("/academy");
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Academy unpublish failed." },
      { status: 500 },
    );
  }
}
