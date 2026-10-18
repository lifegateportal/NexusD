import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { env } from "@/lib/env";
import {
  CodingDeploymentSchema,
  type CodingDeployment,
} from "@/lib/coding-deployment";
import {
  CodingWorkspaceRevisionSchema,
  CodingWorkspaceSchema,
  codingWorkspaceByteCount,
  makeCodingRevisionId,
  makeCodingWorkspaceId,
  type CodingWorkspace,
  type CodingWorkspaceFile,
  type CodingWorkspaceRevision,
  type CodingWorkspaceSnapshot,
} from "@/lib/coding-workspace";

const WORKSPACE_PREFIX = "coding-workspaces/";
const WORKSPACE_META_SUFFIX = "/workspace.json";
const REVISION_PREFIX = "/revisions/";
const DEPLOYMENT_PREFIX = "/deployments/";

type CodingStorage = {
  bucket: string;
  s3: S3Client;
};

export class CodingWorkspaceStorageError extends Error {
  constructor(
    message: string,
    readonly status = 500,
  ) {
    super(message);
    this.name = "CodingWorkspaceStorageError";
  }
}

export class CodingWorkspaceConflictError extends CodingWorkspaceStorageError {
  constructor(readonly current: CodingWorkspaceSnapshot) {
    super("The coding workspace changed before this revision was saved.", 409);
    this.name = "CodingWorkspaceConflictError";
  }
}

function storageConfig(): CodingStorage {
  const {
    R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_BUCKET_NAME,
  } = env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
    throw new CodingWorkspaceStorageError(
      "Coding workspace storage is not configured. Set the R2 storage variables on the server.",
      503,
    );
  }
  return {
    bucket: R2_BUCKET_NAME,
    s3: new S3Client({
      region: "auto",
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
    }),
  };
}

function metaKey(workspaceId: string): string {
  return `${WORKSPACE_PREFIX}${workspaceId}${WORKSPACE_META_SUFFIX}`;
}

function revisionKey(workspaceId: string, revisionId: string): string {
  return `${WORKSPACE_PREFIX}${workspaceId}${REVISION_PREFIX}${revisionId}.json`;
}

function deploymentKey(workspaceId: string, deploymentId: string): string {
  return `${WORKSPACE_PREFIX}${workspaceId}${DEPLOYMENT_PREFIX}${deploymentId}.json`;
}

function isMissingObject(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as Error & { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return error.name === "NoSuchKey" || error.name === "NotFound" || status === 404;
}

async function readJson(storage: CodingStorage, key: string): Promise<unknown | null> {
  try {
    const result = await storage.s3.send(new GetObjectCommand({
      Bucket: storage.bucket,
      Key: key,
    }));
    const raw = await result.Body?.transformToString();
    if (!raw) return null;
    return JSON.parse(raw) as unknown;
  } catch (error) {
    if (isMissingObject(error)) return null;
    throw error;
  }
}

async function writeJson(storage: CodingStorage, key: string, value: unknown): Promise<void> {
  await storage.s3.send(new PutObjectCommand({
    Bucket: storage.bucket,
    Key: key,
    Body: JSON.stringify(value),
    ContentType: "application/json",
    CacheControl: "private, no-cache",
  }));
}

async function listKeys(storage: CodingStorage, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const result = await storage.s3.send(new ListObjectsV2Command({
      Bucket: storage.bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));
    keys.push(
      ...(result.Contents ?? [])
        .map((object) => object.Key)
        .filter((key): key is string => Boolean(key)),
    );
    continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys;
}

function parseWorkspace(value: unknown): CodingWorkspace {
  const parsed = CodingWorkspaceSchema.safeParse(value);
  if (!parsed.success) throw new CodingWorkspaceStorageError("Stored coding workspace metadata is invalid.");
  return parsed.data;
}

function parseRevision(value: unknown): CodingWorkspaceRevision {
  const parsed = CodingWorkspaceRevisionSchema.safeParse(value);
  if (!parsed.success) throw new CodingWorkspaceStorageError("Stored coding workspace revision is invalid.");
  return parsed.data;
}

function parseDeployment(value: unknown): CodingDeployment {
  const parsed = CodingDeploymentSchema.safeParse(value);
  if (!parsed.success) throw new CodingWorkspaceStorageError("Stored coding deployment data is invalid.");
  return parsed.data;
}

async function loadWorkspaceMetadata(storage: CodingStorage, workspaceId: string): Promise<CodingWorkspace | null> {
  const raw = await readJson(storage, metaKey(workspaceId));
  return raw === null ? null : parseWorkspace(raw);
}

async function loadRevision(
  storage: CodingStorage,
  workspaceId: string,
  revisionId: string,
): Promise<CodingWorkspaceRevision | null> {
  const raw = await readJson(storage, revisionKey(workspaceId, revisionId));
  if (raw === null) return null;
  const revision = parseRevision(raw);
  if (revision.workspaceId !== workspaceId || revision.id !== revisionId) {
    throw new CodingWorkspaceStorageError("Stored coding revision belongs to a different workspace.");
  }
  return revision;
}

export async function getCodingWorkspace(workspaceId: string): Promise<CodingWorkspaceSnapshot | null> {
  const storage = storageConfig();
  const workspace = await loadWorkspaceMetadata(storage, workspaceId);
  if (!workspace) return null;
  const revision = await loadRevision(storage, workspaceId, workspace.currentRevisionId);
  if (!revision) throw new CodingWorkspaceStorageError("Coding workspace revision is missing.");
  return { workspace, revision };
}

export async function getCodingDeployment(
  workspaceId: string,
  deploymentId: string,
): Promise<CodingDeployment | null> {
  const storage = storageConfig();
  const raw = await readJson(storage, deploymentKey(workspaceId, deploymentId));
  if (raw === null) return null;
  const deployment = parseDeployment(raw);
  if (deployment.workspaceId !== workspaceId || deployment.id !== deploymentId) {
    throw new CodingWorkspaceStorageError("Stored coding deployment belongs to a different workspace.");
  }
  return deployment;
}

export async function saveCodingDeployment(deployment: CodingDeployment): Promise<void> {
  const parsed = CodingDeploymentSchema.safeParse(deployment);
  if (!parsed.success) throw new CodingWorkspaceStorageError("Coding deployment data is invalid.");
  const storage = storageConfig();
  await writeJson(storage, deploymentKey(parsed.data.workspaceId, parsed.data.id), parsed.data);
}

export async function listCodingDeployments(workspaceId: string): Promise<CodingDeployment[]> {
  const storage = storageConfig();
  const keys = await listKeys(storage, `${WORKSPACE_PREFIX}${workspaceId}${DEPLOYMENT_PREFIX}`);
  const settled = await Promise.allSettled(keys.map((key) => readJson(storage, key)));
  const deployments: CodingDeployment[] = [];
  for (const result of settled) {
    if (result.status === "rejected") {
      console.error("[coding/deployments] Failed to read deployment", result.reason);
      continue;
    }
    if (result.value === null) continue;
    try {
      const deployment = parseDeployment(result.value);
      if (deployment.workspaceId === workspaceId) deployments.push(deployment);
    } catch (error) {
      console.error("[coding/deployments] Ignoring invalid deployment data", error);
    }
  }
  return deployments.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)).slice(0, 100);
}

export async function listCodingWorkspaces(): Promise<CodingWorkspace[]> {
  const storage = storageConfig();
  const keys = await listKeys(storage, WORKSPACE_PREFIX);
  const metadataKeys = keys.filter((key) => key.endsWith(WORKSPACE_META_SUFFIX));
  const settled = await Promise.allSettled(metadataKeys.map((key) => readJson(storage, key)));
  const workspaces: CodingWorkspace[] = [];
  for (const result of settled) {
    if (result.status === "rejected") {
      console.error("[coding/workspaces] Failed to read workspace metadata", result.reason);
      continue;
    }
    if (result.value === null) continue;
    try {
      workspaces.push(parseWorkspace(result.value));
    } catch (error) {
      console.error("[coding/workspaces] Ignoring invalid workspace metadata", error);
    }
  }
  return workspaces.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

export async function createCodingWorkspace(
  name: string,
  files: CodingWorkspaceFile[],
): Promise<CodingWorkspaceSnapshot> {
  const storage = storageConfig();
  const workspaceId = makeCodingWorkspaceId();
  const revisionId = makeCodingRevisionId();
  const now = new Date().toISOString();
  const revision: CodingWorkspaceRevision = {
    id: revisionId,
    workspaceId,
    number: 1,
    parentRevisionId: null,
    createdAt: now,
    reason: "Initial workspace",
    source: "import",
    files,
    byteCount: codingWorkspaceByteCount(files),
  };
  const workspace: CodingWorkspace = {
    id: workspaceId,
    name,
    createdAt: now,
    updatedAt: now,
    currentRevisionId: revisionId,
    revisionNumber: 1,
    fileCount: files.length,
    byteCount: revision.byteCount,
  };
  await writeJson(storage, revisionKey(workspaceId, revisionId), revision);
  await writeJson(storage, metaKey(workspaceId), workspace);
  return { workspace, revision };
}

export async function saveCodingRevision(
  workspaceId: string,
  baseRevisionId: string | null,
  files: CodingWorkspaceFile[],
  reason: string,
  source: CodingWorkspaceRevision["source"],
): Promise<CodingWorkspaceSnapshot> {
  const storage = storageConfig();
  const current = await getCodingWorkspace(workspaceId);
  if (!current) throw new CodingWorkspaceStorageError("Coding workspace not found.", 404);
  if (current.workspace.currentRevisionId !== baseRevisionId) {
    throw new CodingWorkspaceConflictError(current);
  }

  const revisionId = makeCodingRevisionId();
  const now = new Date().toISOString();
  const byteCount = codingWorkspaceByteCount(files);
  const revision: CodingWorkspaceRevision = {
    id: revisionId,
    workspaceId,
    number: current.workspace.revisionNumber + 1,
    parentRevisionId: current.workspace.currentRevisionId,
    createdAt: now,
    reason,
    source,
    files,
    byteCount,
  };
  const workspace: CodingWorkspace = {
    ...current.workspace,
    updatedAt: now,
    currentRevisionId: revisionId,
    revisionNumber: revision.number,
    fileCount: files.length,
    byteCount,
  };
  await writeJson(storage, revisionKey(workspaceId, revisionId), revision);
  await writeJson(storage, metaKey(workspaceId), workspace);
  return { workspace, revision };
}

export async function revertCodingWorkspace(
  workspaceId: string,
  baseRevisionId: string | null,
  targetRevisionId: string,
): Promise<CodingWorkspaceSnapshot> {
  const storage = storageConfig();
  const target = await loadRevision(storage, workspaceId, targetRevisionId);
  if (!target) throw new CodingWorkspaceStorageError("Target coding revision not found.", 404);
  return saveCodingRevision(
    workspaceId,
    baseRevisionId,
    target.files,
    `Revert to revision ${target.number}`,
    "revert",
  );
}

export async function listCodingRevisions(workspaceId: string): Promise<CodingWorkspaceRevision[]> {
  const storage = storageConfig();
  const keys = await listKeys(storage, `${WORKSPACE_PREFIX}${workspaceId}${REVISION_PREFIX}`);
  const settled = await Promise.allSettled(keys.map((key) => readJson(storage, key)));
  const revisions: CodingWorkspaceRevision[] = [];
  for (const result of settled) {
    if (result.status === "rejected") {
      console.error("[coding/workspaces] Failed to read coding revision", result.reason);
      continue;
    }
    if (result.value === null) continue;
    try {
      const revision = parseRevision(result.value);
      if (revision.workspaceId === workspaceId) revisions.push(revision);
    } catch (error) {
      console.error("[coding/workspaces] Ignoring invalid coding revision", error);
    }
  }
  return revisions.sort((left, right) => right.number - left.number);
}

export async function deleteCodingWorkspace(workspaceId: string): Promise<void> {
  const storage = storageConfig();
  const keys = await listKeys(storage, `${WORKSPACE_PREFIX}${workspaceId}/`);
  if (keys.length === 0) return;
  for (let index = 0; index < keys.length; index += 1_000) {
    await storage.s3.send(new DeleteObjectsCommand({
      Bucket: storage.bucket,
      Delete: { Objects: keys.slice(index, index + 1_000).map((Key) => ({ Key })) },
    }));
  }
}
