import { EbookJobStateSchema } from "@/lib/schemas/ebook";
import type { EbookJobState } from "@/lib/schemas/ebook";

export type EbookProject = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  folderId?: string;
  bookTitle: string;
  chapterCount: number;
  totalWordCount: number;
  status: string;
  jobState: EbookJobState;
  /** Slug of the published library entry, set after a successful publish */
  publishedSlug?: string;
  /** R2 public URL for the book cover image */
  coverImageUrl?: string;
  /** R2 public URL for the author's photo */
  authorImageUrl?: string;
  summaryOnly?: boolean;
};

const DB_NAME = "nexus-ebook-projects";
const STORE   = "projects";

function validIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror  = () => reject(req.error);
  });
}

export async function listEbookProjects(): Promise<EbookProject[]> {
  if (typeof window === "undefined") return [];
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => {
        const items = (req.result as EbookProject[]).map((item) => {
          const createdAt = validIsoDate(item.createdAt)
            ? item.createdAt
            : validIsoDate(item.updatedAt)
              ? item.updatedAt
              : new Date().toISOString();
          return {
            ...item,
            createdAt,
            updatedAt: validIsoDate(item.updatedAt) ? item.updatedAt : createdAt,
          };
        }).sort(
          (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        );
        resolve(items);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

function summaryJobState(project: EbookProject): EbookJobState {
    const statuses = new Set([
      "idle", "transcribing", "filtering", "analyzing", "mapping",
      "architecting", "assigning", "writing", "polishing",
      "frontmatter", "exporting", "complete", "failed",
    ]);
    const createdAt = validIsoDate(project.createdAt) ? project.createdAt : new Date().toISOString();
    const updatedAt = validIsoDate(project.updatedAt) ? project.updatedAt : createdAt;
    return EbookJobStateSchema.parse({
      jobId: project.jobState?.jobId || project.id,
      status: statuses.has(project.status) ? project.status : "idle",
      createdAt,
      updatedAt,
    });
  }

export async function listEbookProjectSummaries(): Promise<EbookProject[]> {
    if (typeof window === "undefined") return [];
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, "readonly");
      const request = transaction.objectStore(STORE).openCursor();
      const summaries: EbookProject[] = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          summaries.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
          resolve(summaries);
          return;
        }
        const project = cursor.value as EbookProject;
        summaries.push({
          id: project.id,
          name: project.name,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
          folderId: project.folderId,
          bookTitle: project.bookTitle,
          chapterCount: project.chapterCount,
          totalWordCount: project.totalWordCount,
          status: project.status,
          jobState: summaryJobState(project),
          publishedSlug: project.publishedSlug,
          coverImageUrl: project.coverImageUrl,
          authorImageUrl: project.authorImageUrl,
          summaryOnly: true,
        });
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  }

export async function getEbookProject(id: string): Promise<EbookProject | null> {
    if (typeof window === "undefined") return null;
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).get(id);
      request.onsuccess = () => resolve((request.result as EbookProject | undefined) ?? null);
      request.onerror = () => reject(request.error);
    });
}

export async function saveEbookProject(
  project: EbookProject,
  options: { touchUpdatedAt?: boolean } = {},
): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const getRequest = store.get(project.id);
    getRequest.onsuccess = () => {
      const existing = getRequest.result as EbookProject | undefined;
      const createdAt = validIsoDate(existing?.createdAt)
        ? existing.createdAt
        : validIsoDate(project.createdAt)
          ? project.createdAt
          : new Date().toISOString();
      const updatedAt = options.touchUpdatedAt === false && validIsoDate(project.updatedAt)
        ? project.updatedAt
        : new Date().toISOString();
      store.put({ ...project, createdAt, updatedAt });
    };
    getRequest.onerror = () => reject(getRequest.error);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

export async function deleteEbookProject(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

export function generateEbookProjectId(): string {
  return `ebook-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
