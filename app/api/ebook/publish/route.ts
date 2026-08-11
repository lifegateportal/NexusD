import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { env } from "@/lib/env";
import { EbookManifestSchema } from "@/lib/schemas/ebook";
import {
  PublishedBookEntrySchema,
  PublishedCatalogSchema,
  CoverAccentSchema,
} from "@/lib/schemas/published-book";
import type { PublishedCatalog } from "@/lib/schemas/published-book";
import { z } from "zod";

export const runtime    = "nodejs";
export const maxDuration = 30;

// ── GET /api/ebook/publish — fetch the live published catalog ─────────────────

export async function GET() {
  const {
    R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_BUCKET_NAME,
  } = env;

  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
    return NextResponse.json({ books: [] }, { status: 200 });
  }

  try {
    const s3 = makeS3Client(R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY);
    const res = await s3.send(
      new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: "published/index.json" }),
    );
    const raw = await res.Body?.transformToString();
    if (!raw) return NextResponse.json({ books: [] }, { status: 200 });
    const parsed = PublishedCatalogSchema.safeParse(JSON.parse(raw));
    return NextResponse.json(parsed.success ? parsed.data : { books: [] }, { status: 200 });
  } catch {
    return NextResponse.json({ books: [] }, { status: 200 });
  }
}

const PublishRequestSchema = z.object({
  manifest:       EbookManifestSchema,
  coverAccent:    CoverAccentSchema.default("amber"),
  coverImageUrl:  z.string().url().optional().nullable(),
  authorImageUrl: z.string().url().optional().nullable(),
});

function slugify(title: string, jobId: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  const suffix = jobId.replace(/[^a-z0-9]/gi, "").slice(-6);
  return `${base}-${suffix}`;
}

function buildSynopsis(manifest: z.infer<typeof EbookManifestSchema>): string {
  const candidates = [
    manifest.frontMatter.introduction,
    manifest.frontMatter.preface,
  ];
  for (const text of candidates) {
    if (text && text.length > 60) {
      const clean = text.replace(/#{1,3} /g, "").replace(/\*\*/g, "").trim();
      return clean.slice(0, 340).trimEnd() + (clean.length > 340 ? "…" : "");
    }
  }
  return `${manifest.bookTitle} by ${manifest.authorName}. ${manifest.chapters.length} chapters, ${manifest.totalWordCount.toLocaleString()} words.`;
}

function makeS3Client(accountId: string, accessKey: string, secretKey: string) {
  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json() as unknown;
  let input;
  try {
    input = PublishRequestSchema.parse(body);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid input" },
      { status: 400 },
    );
  }

  const {
    R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_BUCKET_NAME,
    R2_PUBLIC_URL,
  } = env;

  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
    return NextResponse.json(
      { error: "R2 storage must be configured to publish books. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET_NAME." },
      { status: 503 },
    );
  }

  const { manifest, coverAccent } = input;
  // Prefer image URLs passed explicitly; fall back to URLs embedded in the manifest
  const coverImageUrl  = input.coverImageUrl  ?? manifest.coverImageUrl  ?? null;
  const authorImageUrl = input.authorImageUrl ?? manifest.authorImageUrl ?? null;
  const s3   = makeS3Client(R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY);

  let slug = slugify(manifest.bookTitle, manifest.jobId);
  try {
    // C-2 Slug Collision handling
    const getRes = await s3.send(
      new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: "published/index.json" }),
    );
    const getRaw = await getRes.Body?.transformToString();
    const existingCatalog = getRaw ? PublishedCatalogSchema.parse(JSON.parse(getRaw)) : { books: [] };
    
    let counter = 1;
    let baseSlug = slug;
    while (existingCatalog.books.some(b => b.slug === slug)) {
      counter++;
      slug = `${baseSlug}-${counter}`;
    }
  } catch (err) {
    // If index.json doesn't exist, we just proceed
  }

  try {
    // 1. Write the full manifest to R2 (include image URLs so the reader can use them)
    const manifestWithImages = { ...manifest, coverImageUrl, authorImageUrl };
    await s3.send(
      new PutObjectCommand({
        Bucket:       R2_BUCKET_NAME,
        Key:          `published/${slug}/manifest.json`,
        Body:         JSON.stringify(manifestWithImages),
        ContentType:  "application/json",
        CacheControl: "public, max-age=60",
      }),
    );

    // 2. Build catalog entry
    const now   = new Date().toISOString();
    const entry = PublishedBookEntrySchema.parse({
      slug,
      title:          manifest.bookTitle,
      subtitle:       manifest.subtitle,
      authorName:     manifest.authorName,
      publishedAt:    now,
      updatedAt:      now,
      wordCount:      manifest.totalWordCount,
      chapterCount:   manifest.chapters.length,
      synopsis:       buildSynopsis(manifest),
      coverAccent,
      template:       manifest.selectedTemplate,
      coverImageUrl,
      authorImageUrl,
    });

    // 3. Retry loop for conditional ETag-based updates (Audit: C-1)
    let finalUrl = "";
    for (let attempts = 0; attempts < 3; attempts++) {
      let catalog: PublishedCatalog = { updatedAt: now, books: [] };
      let etag: string | undefined;

      // Read existing catalog
      try {
        const existing = await s3.send(
          new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: "published/index.json" }),
        );
        const raw = await existing.Body?.transformToString();
        if (raw) {
          const parsed = PublishedCatalogSchema.safeParse(JSON.parse(raw));
          if (parsed.success) catalog = parsed.data;
        }
        etag = existing.ETag;
      } catch (err: any) {
        if (err.name !== "NoSuchKey" && err.name !== "NotFound") {
          throw err;
        }
        // Index not yet created — start fresh
      }

      // 4. Upsert (remove old entry for this slug, prepend new one)
      catalog.books   = catalog.books.filter((b) => b.slug !== slug);
      catalog.books.unshift(entry);
      catalog.updatedAt = now;

      // 5. Write updated catalog
      try {
        await s3.send(
          new PutObjectCommand({
            Bucket:       R2_BUCKET_NAME,
            Key:          "published/index.json",
            Body:         JSON.stringify(catalog),
            ContentType:  "application/json",
            CacheControl: "public, max-age=30",
            IfMatch:      etag,
          }),
        );
        break; // Success!
      } catch (writeErr: any) {
        if (writeErr.name === "PreconditionFailed") {
          if (attempts === 2) throw new Error("Could not update index.json due to concurrent changes.");
          continue; // ETag mismatched, try again
        } else {
          throw writeErr;
        }
      }
    }

    const publicUrl = R2_PUBLIC_URL
      ? `${R2_PUBLIC_URL.replace(/\/$/, "")}/published/${slug}/manifest.json`
      : null;

    revalidatePath("/library");

    return NextResponse.json({ slug, publicUrl }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Publish failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// ── PATCH /api/ebook/publish — update catalog entry metadata without re-publishing ──

const PatchCatalogRequestSchema = z.object({
  slug:        z.string().min(1),
  title:       z.string().optional(),
  subtitle:    z.string().optional(),
  authorName:  z.string().optional(),
  synopsis:    z.string().optional(),
  coverAccent: CoverAccentSchema.optional(),
});

export async function PATCH(req: NextRequest) {
  let input;
  try {
    input = PatchCatalogRequestSchema.parse(await req.json() as unknown);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid input" },
      { status: 400 },
    );
  }

  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME } = env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
    return NextResponse.json({ error: "R2 storage not configured." }, { status: 503 });
  }

  const { slug, ...fields } = input;
  const s3  = makeS3Client(R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY);
  const now = new Date().toISOString();

  try {
    // Read current catalog
    let catalog: PublishedCatalog = { updatedAt: now, books: [] };
    try {
      const existing = await s3.send(
        new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: "published/index.json" }),
      );
      const raw = await existing.Body?.transformToString();
      if (raw) {
        const parsed = PublishedCatalogSchema.safeParse(JSON.parse(raw));
        if (parsed.success) catalog = parsed.data;
      }
    } catch { /* index may not exist yet */ }

    const idx = catalog.books.findIndex((b) => b.slug === slug);
    if (idx === -1) {
      return NextResponse.json({ error: `Book with slug "${slug}" not found in catalog.` }, { status: 404 });
    }

    // Merge patch
    catalog.books[idx] = PublishedBookEntrySchema.parse({
      ...catalog.books[idx],
      ...fields,
      updatedAt: now,
    });
    catalog.updatedAt = now;

    await s3.send(
      new PutObjectCommand({
        Bucket:       R2_BUCKET_NAME,
        Key:          "published/index.json",
        Body:         JSON.stringify(catalog),
        ContentType:  "application/json",
        CacheControl: "public, max-age=30",
      }),
    );

    revalidatePath("/library");

    return NextResponse.json({ slug, updatedAt: now }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Patch failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// ── DELETE /api/ebook/publish — remove a book from the library catalog ────────

const DeleteRequestSchema = z.object({ slug: z.string().min(1) });

export async function DELETE(req: NextRequest) {
  let input;
  try {
    input = DeleteRequestSchema.parse(await req.json() as unknown);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid input" },
      { status: 400 },
    );
  }

  const {
    R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_BUCKET_NAME,
  } = env;

  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
    return NextResponse.json(
      { error: "R2 storage must be configured to manage books." },
      { status: 503 },
    );
  }

  const { slug } = input;
  const s3 = makeS3Client(R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY);

  try {
    // 1. Remove book from catalog index
    const now = new Date().toISOString();
    let catalog: PublishedCatalog = { updatedAt: now, books: [] };
    try {
      const existing = await s3.send(
        new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: "published/index.json" }),
      );
      const raw = await existing.Body?.transformToString();
      if (raw) {
        const parsed = PublishedCatalogSchema.safeParse(JSON.parse(raw));
        if (parsed.success) catalog = parsed.data;
      }
    } catch {
      // Index missing — nothing to remove
    }

    catalog.books     = catalog.books.filter((b) => b.slug !== slug);
    catalog.updatedAt = now;

    await s3.send(
      new PutObjectCommand({
        Bucket:       R2_BUCKET_NAME,
        Key:          "published/index.json",
        Body:         JSON.stringify(catalog),
        ContentType:  "application/json",
        CacheControl: "public, max-age=30",
      }),
    );

    // 2. Delete the manifest file from R2
    await s3.send(
      new DeleteObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key:    `published/${slug}/manifest.json`,
      }),
    ).catch(() => { /* best-effort — file may not exist */ });

    // 3. Bust the Next.js ISR cache so the library page reflects the removal immediately
    revalidatePath("/library");

    return NextResponse.json({ slug }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Delete failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
