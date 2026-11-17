import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { makeR2Client } from "@/lib/r2-storage";
import {
  DirectorFaqCatalogSchema,
  DirectorFaqSchema,
  LibraryFaqCatalogSchema,
  LibraryFaqSchema,
  STARTER_FAQS,
} from "@/lib/schemas/library-faq";

export const runtime = "nodejs";

const PRIVATE_KEY = "director/faqs/index.json";
const PUBLIC_KEY = "published/faqs/index.json";
const ActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save"), faq: DirectorFaqSchema }).strict(),
  z.object({ action: z.literal("publish"), faqId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/) }).strict(),
  z.object({ action: z.literal("unpublish"), faqId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/) }).strict(),
  z.object({ action: z.literal("delete"), faqId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/) }).strict(),
]);

function isMissingObject(error: unknown): boolean {
  return error instanceof Error && ["NoSuchKey", "NotFound"].includes(error.name);
}

function assertStorageConfigured(): void {
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_BUCKET_NAME) {
    throw new Error("Configure Cloudflare R2 credentials and bucket in Nexus Director to manage FAQs.");
  }
}

function directorAuthIsConfigured(): boolean {
  return Boolean(process.env.AUTH_PASSWORD && process.env.AUTH_COOKIE_SECRET);
}

async function readJsonObject(key: string): Promise<unknown | null> {
  assertStorageConfigured();
  try {
    const result = await makeR2Client().send(new GetObjectCommand({ Bucket: env.R2_BUCKET_NAME, Key: key }));
    const raw = await result.Body?.transformToString();
    if (!raw) throw new Error(`R2 object ${key} is empty.`);
    return JSON.parse(raw) as unknown;
  } catch (error) {
    if (isMissingObject(error)) return null;
    throw error;
  }
}

async function writeJsonObject(key: string, value: unknown, isPublic = false): Promise<void> {
  assertStorageConfigured();
  await makeR2Client().send(new PutObjectCommand({
    Bucket: env.R2_BUCKET_NAME,
    Key: key,
    Body: JSON.stringify(value),
    ContentType: "application/json",
    CacheControl: isPublic ? "public, max-age=60" : "private, no-store",
  }));
}

async function deleteObject(key: string): Promise<void> {
  assertStorageConfigured();
  await makeR2Client().send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET_NAME, Key: key }));
}

async function readPrivateCatalog(): Promise<z.infer<typeof DirectorFaqCatalogSchema>> {
  const raw = await readJsonObject(PRIVATE_KEY);
  if (raw) return DirectorFaqCatalogSchema.parse(raw);
  const now = new Date().toISOString();
  return DirectorFaqCatalogSchema.parse({
    updatedAt: now,
    faqs: STARTER_FAQS.map((faq) => ({ ...faq, status: "draft", updatedAt: now })),
  });
}

async function readPublicCatalog(): Promise<z.infer<typeof LibraryFaqCatalogSchema>> {
  const raw = await readJsonObject(PUBLIC_KEY);
  return raw
    ? LibraryFaqCatalogSchema.parse(raw)
    : { updatedAt: new Date().toISOString(), faqs: [] };
}

async function savePrivate(faqs: z.infer<typeof DirectorFaqSchema>[]) {
  const catalog = DirectorFaqCatalogSchema.parse({ updatedAt: new Date().toISOString(), faqs });
  await writeJsonObject(PRIVATE_KEY, catalog);
  return catalog;
}

async function savePublic(faqs: z.infer<typeof LibraryFaqSchema>[]): Promise<void> {
  const catalog = LibraryFaqCatalogSchema.parse({ updatedAt: new Date().toISOString(), faqs });
  if (faqs.length) await writeJsonObject(PUBLIC_KEY, catalog, true);
  else await deleteObject(PUBLIC_KEY);
}

export async function GET() {
  if (!directorAuthIsConfigured()) {
    return NextResponse.json({ error: "Configure Director authentication before managing FAQs." }, { status: 503 });
  }
  try {
    return NextResponse.json(await readPrivateCatalog(), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not load Director FAQs." },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  if (!directorAuthIsConfigured()) {
    return NextResponse.json({ error: "Configure Director authentication before managing FAQs." }, { status: 503 });
  }
  let action: z.infer<typeof ActionSchema>;
  try {
    action = ActionSchema.parse(await request.json() as unknown);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid FAQ action." },
      { status: 400 },
    );
  }

  try {
    const catalog = await readPrivateCatalog();
    const now = new Date().toISOString();
    if (action.action === "save") {
      const savedFaq = DirectorFaqSchema.parse({ ...action.faq, status: "draft", updatedAt: now });
      const exists = catalog.faqs.some((faq) => faq.id === savedFaq.id);
      if (!exists && catalog.faqs.length >= 100) {
        return NextResponse.json({ error: "The Director FAQ list has reached its 100-question limit." }, { status: 409 });
      }
      const updated = await savePrivate(exists
        ? catalog.faqs.map((faq) => faq.id === savedFaq.id ? savedFaq : faq)
        : [...catalog.faqs, savedFaq]);
      const publicCatalog = await readPublicCatalog();
      await savePublic(publicCatalog.faqs.filter((faq) => faq.id !== savedFaq.id));
      return NextResponse.json(updated);
    }

    const faq = catalog.faqs.find((item) => item.id === action.faqId);
    if (!faq) return NextResponse.json({ error: "FAQ not found in the Director list." }, { status: 404 });
    const publicCatalog = await readPublicCatalog();

    if (action.action === "publish") {
      if (!faq.answer?.trim() || faq.sources.length === 0) {
        return NextResponse.json({ error: "Generate an answer from published books and videos before publishing this FAQ." }, { status: 409 });
      }
      const publishedFaq = LibraryFaqSchema.parse({
        ...faq,
        publishedAt: now,
        updatedAt: now,
      });
      if (
        !publicCatalog.faqs.some((item) => item.id === faq.id)
        && publicCatalog.faqs.length >= 100
      ) {
        return NextResponse.json({ error: "The public FAQ list has reached its 100-question limit." }, { status: 409 });
      }
      await savePublic([
        ...publicCatalog.faqs.filter((item) => item.id !== faq.id),
        publishedFaq,
      ]);
      return NextResponse.json(await savePrivate(catalog.faqs.map((item) =>
        item.id === faq.id ? { ...item, status: "published" as const, updatedAt: now } : item,
      )));
    }

    if (action.action === "unpublish") {
      await savePublic(publicCatalog.faqs.filter((item) => item.id !== faq.id));
      return NextResponse.json(await savePrivate(catalog.faqs.map((item) =>
        item.id === faq.id ? { ...item, status: "draft" as const, updatedAt: now } : item,
      )));
    }

    await savePublic(publicCatalog.faqs.filter((item) => item.id !== faq.id));
    return NextResponse.json(await savePrivate(catalog.faqs.filter((item) => item.id !== faq.id)));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "The FAQ operation failed." },
      { status: 500 },
    );
  }
}
