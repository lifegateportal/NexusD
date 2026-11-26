import { createHmac, randomUUID } from "node:crypto";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { z } from "zod";
import { env } from "@/lib/env";
import { makeR2Client } from "@/lib/r2-storage";
import {
  LibraryTrafficEventInputSchema,
  LibraryTrafficSummarySchema,
} from "@/lib/schemas/library-analytics";
import type { LibraryTrafficSummary } from "@/lib/schemas/library-analytics";

const EVENT_PREFIX = "director/library-analytics/events";
const DeviceSchema = z.enum(["mobile", "tablet", "desktop"]);

const StoredEventSchema = z.object({
  viewedAt: z.string().datetime(),
  path: z.string().regex(/^\/library(?:\/[^\s?#]*)?$/).max(300),
  sessionHash: z.string().regex(/^[a-f0-9]{64}$/),
  browserHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  source: z.string().trim().min(1).max(253),
  device: DeviceSchema,
}).strict();

function assertStorageConfigured(): void {
  if (
    !env.R2_ACCOUNT_ID
    || !env.R2_ACCESS_KEY_ID
    || !env.R2_SECRET_ACCESS_KEY
    || !env.R2_BUCKET_NAME
  ) {
    throw new Error("Configure Cloudflare R2 before collecting library traffic.");
  }
  if (!env.AUTH_PASSWORD || !env.AUTH_COOKIE_SECRET) {
    throw new Error("Configure Director authentication before collecting library traffic.");
  }
}

function sessionHash(sessionId: string): string {
  const secret = env.AUTH_COOKIE_SECRET;
  if (!secret) throw new Error("Configure Director authentication before collecting library traffic.");
  return createHmac("sha256", secret)
    .update(sessionId)
    .digest("hex");
}

function browserHash(browserId: string): string {
  const secret = env.AUTH_COOKIE_SECRET;
  if (!secret) throw new Error("Configure Director authentication before collecting library traffic.");
  return createHmac("sha256", secret)
    .update("browser:")
    .update(browserId)
    .digest("hex");
}

export async function recordLibraryPageView(
  input: z.infer<typeof LibraryTrafficEventInputSchema>,
): Promise<void> {
  assertStorageConfigured();
  const viewedAt = new Date();
  const date = viewedAt.toISOString().slice(0, 10);
  const event = StoredEventSchema.parse({
    viewedAt: viewedAt.toISOString(),
    path: input.path,
    sessionHash: sessionHash(input.sessionId),
    ...(input.browserId ? { browserHash: browserHash(input.browserId) } : {}),
    source: input.source,
    device: input.device,
  });

  await makeR2Client().send(new PutObjectCommand({
    Bucket: env.R2_BUCKET_NAME,
    Key: `${EVENT_PREFIX}/${date}/${randomUUID()}.json`,
    Body: JSON.stringify(event),
    ContentType: "application/json",
    CacheControl: "private, no-store",
  }));
}

async function listEventKeys(
  client: ReturnType<typeof makeR2Client>,
  date: string,
): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const result = await client.send(new ListObjectsV2Command({
      Bucket: env.R2_BUCKET_NAME,
      Prefix: `${EVENT_PREFIX}/${date}/`,
      ContinuationToken: continuationToken,
    }));
    keys.push(...(result.Contents ?? []).flatMap((object) => object.Key ? [object.Key] : []));
    continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
  } while (continuationToken);

  return keys;
}

async function readEvent(client: ReturnType<typeof makeR2Client>, key: string) {
  const result = await client.send(new GetObjectCommand({
    Bucket: env.R2_BUCKET_NAME,
    Key: key,
  }));
  const body = await result.Body?.transformToString();
  if (!body) throw new Error(`Library traffic event ${key} is empty.`);
  return StoredEventSchema.parse(JSON.parse(body) as unknown);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapItem: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapItem(items[index]);
    }
  }));
  return results;
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

export async function readLibraryTraffic(days: number): Promise<LibraryTrafficSummary> {
  assertStorageConfigured();
  const client = makeR2Client();
  const today = new Date();
  const dates = Array.from({ length: days }, (_, index) => {
    const date = new Date(Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth(),
      today.getUTCDate() - (days - index - 1),
    ));
    return date.toISOString().slice(0, 10);
  });
  const keysByDay = await Promise.all(dates.map((date) => listEventKeys(client, date)));
  const allKeys = keysByDay.flat();
  const events = await mapWithConcurrency(allKeys, 16, (key) => readEvent(client, key));
  const pageViewsByDay = new Map(dates.map((date) => [date, 0]));
  const sessionsByDay = new Map(dates.map((date) => [date, new Set<string>()]));
  const sessions = new Set<string>();
  const browserProfiles = new Set<string>();
  const pages = new Map<string, number>();
  const sources = new Map<string, number>();
  const devices = new Map<string, number>();

  for (const event of events) {
    const date = event.viewedAt.slice(0, 10);
    pageViewsByDay.set(date, (pageViewsByDay.get(date) ?? 0) + 1);
    sessionsByDay.get(date)?.add(event.sessionHash);
    sessions.add(event.sessionHash);
    if (event.browserHash) browserProfiles.add(event.browserHash);
    increment(pages, event.path);
    increment(sources, event.source);
    increment(devices, event.device);
  }

  const groups = (map: Map<string, number>) => [...map.entries()]
    .map(([label, pageViews]) => ({ label, pageViews }))
    .sort((a, b) => b.pageViews - a.pageViews || a.label.localeCompare(b.label))
    .slice(0, 10);

  return LibraryTrafficSummarySchema.parse({
    days,
    pageViews: events.length,
    sessions: sessions.size,
    estimatedUniqueBrowsers: browserProfiles.size,
    byDay: dates.map((date) => ({
      date,
      pageViews: pageViewsByDay.get(date) ?? 0,
      sessions: sessionsByDay.get(date)?.size ?? 0,
    })),
    topPages: groups(pages),
    topSources: groups(sources),
    devices: groups(devices),
  });
}
