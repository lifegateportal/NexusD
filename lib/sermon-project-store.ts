import { z } from "zod";

const DB_NAME = "nexus-sermon-projects";
const STORE = "projects";

const ScriptureCardSchema = z.object({
  id: z.string().min(1),
  ref: z.string().min(1),
  text: z.string(),
  source: z.enum(["detected", "suggested"]),
  confidence: z.number().optional(),
  reason: z.string().optional(),
}).strict();

const ChatEntrySchema = z.object({
  id: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  markdown: z.string(),
}).strict();

export const SermonAssistantSnapshotSchema = z.object({
  rawTranscript: z.string(),
  organizedMarkdown: z.string(),
  manualNotes: z.string(),
  scriptureCards: z.array(ScriptureCardSchema),
  chatEntries: z.array(ChatEntrySchema).default([]),
}).strict();

export const SermonProjectRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(160),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  folderId: z.string().min(1).optional(),
  sermonAssistant: SermonAssistantSnapshotSchema,
}).strict();

export type SermonAssistantSnapshot = z.infer<typeof SermonAssistantSnapshotSchema>;
export type SermonProjectRecord = z.infer<typeof SermonProjectRecordSchema>;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function normalizeSermonProjectRecord(input: unknown): SermonProjectRecord | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const rawSermon = record.sermonAssistant;
  const decoded = typeof rawSermon === "string"
    ? (() => {
        try {
          return JSON.parse(rawSermon) as unknown;
        } catch {
          return null;
        }
      })()
    : rawSermon;
  if (!decoded || typeof decoded !== "object") return null;

  const parsedSnapshot = SermonAssistantSnapshotSchema.safeParse(decoded);
  if (!parsedSnapshot.success) return null;

  const createdAt = validDate(record.createdAt) ? record.createdAt : new Date().toISOString();
  const parsed = SermonProjectRecordSchema.safeParse({
    id: typeof record.id === "string" && record.id.trim()
      ? record.id
      : `sermon-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: typeof record.name === "string" && record.name.trim() ? record.name : "Sermon",
    createdAt,
    updatedAt: validDate(record.updatedAt) ? record.updatedAt : createdAt,
    folderId: typeof record.folderId === "string" && record.folderId.trim() ? record.folderId : undefined,
    sermonAssistant: parsedSnapshot.data,
  });
  return parsed.success ? parsed.data : null;
}

export async function listSermonProjects(): Promise<SermonProjectRecord[]> {
  if (typeof window === "undefined") return [];
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, "readonly");
    const request = transaction.objectStore(STORE).getAll();
    request.onsuccess = () => {
      const records = request.result
        .map((item: unknown) => normalizeSermonProjectRecord(item))
        .filter((item: SermonProjectRecord | null): item is SermonProjectRecord => item !== null)
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      resolve(records);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function saveSermonProject(
  record: SermonProjectRecord,
  options: { touchUpdatedAt?: boolean } = {},
): Promise<SermonProjectRecord> {
  const parsed = SermonProjectRecordSchema.parse(record);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const existingRequest = store.get(parsed.id);
    existingRequest.onsuccess = () => {
      const existing = normalizeSermonProjectRecord(existingRequest.result);
      const saved = SermonProjectRecordSchema.parse({
        ...parsed,
        createdAt: existing?.createdAt ?? parsed.createdAt,
        updatedAt: options.touchUpdatedAt === false ? parsed.updatedAt : new Date().toISOString(),
      });
      store.put(saved);
      transaction.oncomplete = () => resolve(saved);
    };
    existingRequest.onerror = () => reject(existingRequest.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function deleteSermonProject(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function fetchSermonProjectsFromCloud(): Promise<{
  projects: SermonProjectRecord[];
  deletedProjectIds: string[];
}> {
  const response = await fetch("/api/projects?kind=sermon", {
    cache: "no-store",
    credentials: "same-origin",
  });
  const payload = await response.json().catch(() => null) as {
    projects?: unknown[];
    deletedProjectIds?: string[];
    error?: string;
  } | null;
  if (!response.ok) {
    throw new Error(payload?.error ?? "Could not load sermon projects from cloud.");
  }
  return {
    projects: (payload?.projects ?? [])
      .map(normalizeSermonProjectRecord)
      .filter((item): item is SermonProjectRecord => item !== null),
    deletedProjectIds: Array.isArray(payload?.deletedProjectIds)
      ? payload.deletedProjectIds.filter((id): id is string => typeof id === "string")
      : [],
  };
}

export async function saveSermonProjectToCloud(record: SermonProjectRecord): Promise<void> {
  const response = await fetch("/api/projects?kind=sermon", {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: SermonProjectRecordSchema.parse(record) }),
  });
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) {
    throw new Error(payload?.error ?? "Could not save sermon project to cloud.");
  }
}

export async function deleteSermonProjectFromCloud(id: string): Promise<void> {
  const response = await fetch("/api/projects?kind=sermon", {
    method: "DELETE",
    cache: "no-store",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) {
    throw new Error(payload?.error ?? "Could not delete sermon project from cloud.");
  }
}
