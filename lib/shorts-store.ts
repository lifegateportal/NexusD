import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { env } from "@/lib/env";
import { makeR2Client } from "@/lib/r2-storage";
import {
  PublicShortCatalogSchema,
  PublishedShortProjectSchema,
  ShortAgentSettingsSchema,
  ShortCatalogSchema,
  ShortProjectSchema,
  ShortProjectVersionIndexSchema,
  type ShortProject,
} from "@/lib/schemas/video-short";
import { getShortThumbnailUrl } from "@/lib/short-video-utils";

const PRIVATE_CATALOG_KEY = "director/shorts/index.json";
const PUBLIC_CATALOG_KEY = "published/shorts/index.json";
const AGENT_SETTINGS_KEY = "director/shorts/agent-settings.json";
const MAX_PROJECT_VERSIONS = 20;

function historyIndexKey(slug: string): string {
  return `director/shorts/${slug}/history.json`;
}

function historyVersionKey(slug: string, versionId: string): string {
  return `director/shorts/${slug}/history/${versionId}.json`;
}

function belongsToHttpsDomain(value: string | undefined, domain: string): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && (url.hostname === domain || url.hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function assertStorageConfigured(): void {
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_BUCKET_NAME) {
    throw new Error("Configure Cloudflare R2 credentials and bucket to manage video shorts.");
  }
}

async function readJsonObject(key: string): Promise<unknown | null> {
  assertStorageConfigured();
  try {
    const result = await makeR2Client().send(new GetObjectCommand({
      Bucket: env.R2_BUCKET_NAME,
      Key: key,
    }));
    const raw = await result.Body?.transformToString();
    if (!raw) throw new Error(`R2 object ${key} is empty.`);
    return JSON.parse(raw) as unknown;
  } catch (error) {
    if (error instanceof Error && ["NoSuchKey", "NotFound"].includes(error.name)) return null;
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

function summaryFor(project: ShortProject) {
  const thumbnailUrl = getShortThumbnailUrl(project);
  return {
    slug: project.slug,
    title: project.title,
    sourceType: project.source.type,
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    ...(project.source.type === "youtube" ? { videoTitle: project.source.videoTitle } : {}),
    status: project.status,
    updatedAt: project.updatedAt,
  };
}

function publicSummaryFor(project: ShortProject) {
  const summary = summaryFor(project);
  return {
    slug: summary.slug,
    title: summary.title,
    sourceType: summary.sourceType,
    ...(summary.thumbnailUrl ? { thumbnailUrl: summary.thumbnailUrl } : {}),
    ...(summary.videoTitle ? { videoTitle: summary.videoTitle } : {}),
    updatedAt: summary.updatedAt,
  };
}

export async function listPrivateShorts() {
  const raw = await readJsonObject(PRIVATE_CATALOG_KEY);
  return raw
    ? ShortCatalogSchema.parse(raw)
    : { updatedAt: new Date().toISOString(), shorts: [] };
}

export async function readShortAgentSettings() {
  const raw = await readJsonObject(AGENT_SETTINGS_KEY);
  return ShortAgentSettingsSchema.parse(raw ?? {});
}

export async function saveShortAgentSettings(input: unknown) {
  const settings = ShortAgentSettingsSchema.parse(input);
  await writeJsonObject(AGENT_SETTINGS_KEY, settings);
  return settings;
}

export async function readPrivateShort(slug: string): Promise<ShortProject | null> {
  const raw = await readJsonObject(`director/shorts/${slug}.json`);
  return raw ? ShortProjectSchema.parse(raw) : null;
}

export async function listPrivateShortVersions(slug: string) {
  const raw = await readJsonObject(historyIndexKey(slug));
  return ShortProjectVersionIndexSchema.parse(raw ?? { versions: [] });
}

export async function readPrivateShortVersion(slug: string, versionId: string): Promise<ShortProject | null> {
  const index = await listPrivateShortVersions(slug);
  if (!index.versions.some((version) => version.id === versionId)) return null;
  const raw = await readJsonObject(historyVersionKey(slug, versionId));
  return raw ? ShortProjectSchema.parse(raw) : null;
}

async function archivePrivateShortVersion(project: ShortProject): Promise<void> {
  const index = await listPrivateShortVersions(project.slug);
  const id = crypto.randomUUID();
  const savedAt = new Date().toISOString();
  await writeJsonObject(historyVersionKey(project.slug, id), project);
  const versions = ShortProjectVersionIndexSchema.parse({
    versions: [
      { id, savedAt, title: project.title, status: project.status, updatedAt: project.updatedAt },
      ...index.versions,
    ].slice(0, MAX_PROJECT_VERSIONS),
  });
  await writeJsonObject(historyIndexKey(project.slug), versions);
  const retained = new Set(versions.versions.map((version) => version.id));
  await Promise.all(index.versions
    .filter((version) => !retained.has(version.id))
    .map((version) => deleteObject(historyVersionKey(project.slug, version.id))));
}

export async function savePrivateShort(
  projectInput: unknown,
  status: "draft" | "published" = "draft",
): Promise<ShortProject> {
  const project = ShortProjectSchema.parse(projectInput);
  const catalog = await listPrivateShorts();
  if (!catalog.shorts.some((short) => short.slug === project.slug) && catalog.shorts.length >= 500) {
    throw new Error("The private Shorts Studio catalog has reached its 500-draft limit.");
  }
  const saved = ShortProjectSchema.parse({ ...project, status, updatedAt: new Date().toISOString() });
  const previous = await readPrivateShort(saved.slug);
  if (previous) {
    const comparablePrevious = { ...previous, status: "draft", updatedAt: "" };
    const comparableNext = { ...saved, status: "draft", updatedAt: "" };
    if (JSON.stringify(comparablePrevious) !== JSON.stringify(comparableNext)) {
      await archivePrivateShortVersion(previous);
    }
  }
  await writeJsonObject(`director/shorts/${saved.slug}.json`, saved);
  await writeJsonObject(PRIVATE_CATALOG_KEY, ShortCatalogSchema.parse({
    updatedAt: new Date().toISOString(),
    shorts: [summaryFor(saved), ...catalog.shorts.filter((short) => short.slug !== saved.slug)],
  }));
  return saved;
}

export async function publishShort(projectInput: unknown): Promise<ShortProject> {
  const project = PublishedShortProjectSchema.parse(projectInput);
  if (project.source.type === "upload") {
    if (!env.R2_PUBLIC_URL) throw new Error("Configure R2_PUBLIC_URL before publishing an uploaded video short.");
    const expectedPrefix = `${env.R2_PUBLIC_URL.replace(/\/$/, "")}/published/shorts/assets/`;
    if (!project.source.sourceUrl?.startsWith(expectedPrefix)) {
      throw new Error("Uploaded source must use a video asset created by the Shorts Studio.");
    }
  }
  if (project.thumbnailUrl) {
    if (!env.R2_PUBLIC_URL) throw new Error("Configure R2_PUBLIC_URL before publishing a custom thumbnail.");
    const expectedPrefix = `${env.R2_PUBLIC_URL.replace(/\/$/, "")}/published/shorts/assets/`;
    if (!project.thumbnailUrl.startsWith(expectedPrefix)) {
      throw new Error("Custom thumbnail must use an image asset uploaded through the Shorts Studio.");
    }
  }
  const expectedAssetPrefix = env.R2_PUBLIC_URL
    ? `${env.R2_PUBLIC_URL.replace(/\/$/, "")}/published/shorts/assets/`
    : "";
  if (
    (project.brollClips.some((clip) => clip.provider === "upload")
      || project.musicTracks.some((track) => track.provider === "upload"))
    && !expectedAssetPrefix
  ) {
    throw new Error("Configure R2_PUBLIC_URL before publishing B-roll or music tracks.");
  }
  for (const clip of project.brollClips) {
    if (clip.provider === "upload" && !clip.videoUrl.startsWith(expectedAssetPrefix)) {
      throw new Error("Uploaded B-roll must use an asset uploaded through the Shorts Studio.");
    }
    if (clip.provider === "pexels" && !belongsToHttpsDomain(clip.videoUrl, "videos.pexels.com")) {
      throw new Error("Pexels B-roll must use a secure Pexels video URL.");
    }
    if (clip.provider === "pexels" && !belongsToHttpsDomain(clip.providerPageUrl, "pexels.com")) {
      throw new Error("Pexels B-roll needs a valid Pexels source link.");
    }
    if (
      clip.provider === "pexels"
      && (!belongsToHttpsDomain(clip.creatorUrl, "pexels.com")
        || !belongsToHttpsDomain(clip.licenseUrl, "pexels.com"))
    ) {
      throw new Error("Pexels B-roll needs valid creator and license links.");
    }
  }
  for (const track of project.musicTracks) {
    if (track.provider === "upload" && !track.audioUrl.startsWith(expectedAssetPrefix)) {
      throw new Error("Uploaded music must use an asset uploaded through the Shorts Studio.");
    }
    if (track.provider === "jamendo" && !belongsToHttpsDomain(track.audioUrl, "jamendo.com")) {
      throw new Error("Jamendo music must use a secure Jamendo audio URL.");
    }
    if (track.provider === "jamendo" && !belongsToHttpsDomain(track.providerPageUrl, "jamendo.com")) {
      throw new Error("Jamendo music needs a valid Jamendo track link.");
    }
    if (
      track.provider === "jamendo"
      && (!belongsToHttpsDomain(track.creatorUrl, "jamendo.com")
        || !belongsToHttpsDomain(track.licenseUrl, "jamendo.com"))
    ) {
      throw new Error("Jamendo music needs valid artist and license links.");
    }
    if (track.provider === "jamendo" && !env.JAMENDO_COMMERCIAL_USE_APPROVED) {
      throw new Error("Confirm Jamendo commercial/API licensing before publishing Jamendo music.");
    }
  }

  const catalog = await listPublicShorts();
  if (!catalog.shorts.some((short) => short.slug === project.slug) && catalog.shorts.length >= 500) {
    throw new Error("The public video shorts catalog has reached its 500-short limit.");
  }
  const published = ShortProjectSchema.parse({ ...project, updatedAt: new Date().toISOString() });
  await writeJsonObject(`published/shorts/${published.slug}.json`, published, true);
  await writeJsonObject(PUBLIC_CATALOG_KEY, PublicShortCatalogSchema.parse({
    updatedAt: new Date().toISOString(),
    shorts: [
      publicSummaryFor(published),
      ...catalog.shorts.filter((short) => short.slug !== published.slug),
    ],
  }), true);
  await savePrivateShort(published, "published");
  return published;
}

export async function listPublicShorts() {
  const raw = await readJsonObject(PUBLIC_CATALOG_KEY);
  return raw
    ? PublicShortCatalogSchema.parse(raw)
    : { updatedAt: new Date().toISOString(), shorts: [] };
}

export async function readPublicShort(slug: string): Promise<ShortProject | null> {
  const raw = await readJsonObject(`published/shorts/${slug}.json`);
  if (!raw) return null;
  return PublishedShortProjectSchema.parse(raw);
}

export async function unpublishShort(slug: string): Promise<void> {
  const project = await readPrivateShort(slug);
  const catalog = await listPublicShorts();
  if (!catalog.shorts.some((short) => short.slug === slug)) {
    throw new Error("This short is not currently published.");
  }
  await deleteObject(`published/shorts/${slug}.json`);
  await writeJsonObject(PUBLIC_CATALOG_KEY, PublicShortCatalogSchema.parse({
    updatedAt: new Date().toISOString(),
    shorts: catalog.shorts.filter((short) => short.slug !== slug),
  }), true);
  if (project) {
    if (project.source.type === "upload" && project.source.sourceUrl && env.R2_PUBLIC_URL) {
      const base = new URL(`${env.R2_PUBLIC_URL.replace(/\/$/, "")}/`);
      const source = new URL(project.source.sourceUrl);
      const key = source.origin === base.origin && source.pathname.startsWith(`${base.pathname}published/shorts/assets/`)
        ? decodeURIComponent(source.pathname.slice(base.pathname.length))
        : null;
      if (key) await deleteObject(key);
    }
    const draft = project.source.type === "upload"
      ? { ...project, source: { type: "upload" as const, fileName: project.source.fileName } }
      : project;
    await savePrivateShort(draft, "draft");
  }
}

export async function deletePrivateShort(slug: string): Promise<void> {
  const catalog = await listPrivateShorts();
  const versions = await listPrivateShortVersions(slug);
  await deleteObject(`director/shorts/${slug}.json`);
  await Promise.all([
    deleteObject(historyIndexKey(slug)),
    ...versions.versions.map((version) => deleteObject(historyVersionKey(slug, version.id))),
  ]);
  await writeJsonObject(PRIVATE_CATALOG_KEY, ShortCatalogSchema.parse({
    updatedAt: new Date().toISOString(),
    shorts: catalog.shorts.filter((short) => short.slug !== slug),
  }));
}
