import type { AcademyPackage } from "@/lib/schemas/academy";
import type { SiteConfig } from "@/lib/schemas/site-config";
import type { IngestResult, LogicTransformResult } from "@/lib/schemas/blueprint";
import type { UiManifestResult } from "@/lib/schemas/ui-manifest";
import type { EbookManifest, EbookJobState } from "@/lib/schemas/ebook";

export type ChatMessage = { role: "user" | "assistant" | "system"; content: string };

export type ProjectSnapshot = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  folderId?: string;
  academy: AcademyPackage | null;
  siteConfig: SiteConfig;
  deliveryInstructions: string;
  chatHistory: ChatMessage[];
  blueprint: IngestResult | null;
  logicResult: LogicTransformResult | null;
  uiResult: UiManifestResult | null;
  /** Completed ebook manifest — present when the book pipeline has finished */
  ebookManifest?: EbookManifest | null;
  /** Full ebook pipeline job state — enables resume from any stage */
  ebookJobState?: EbookJobState | null;
  /** Slug of the published library entry, set after a successful publish */
  publishedSlug?: string;
  /** R2 public URL for the book cover image */
  coverImageUrl?: string;
  /** R2 public URL for the author's photo */
  authorImageUrl?: string;
};

// ── IndexedDB storage (no 5MB quota limit) ───────────────────────────────────
const DB_NAME  = "nexus-director-projects";
const STORE    = "projects";
const LS_KEY   = "nexus_projects"; // legacy localStorage key — used for migration only

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

// One-time migration: move any existing localStorage projects into IndexedDB
async function migrateFromLocalStorage(): Promise<void> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const items = JSON.parse(raw) as ProjectSnapshot[];
    if (!Array.isArray(items) || items.length === 0) { localStorage.removeItem(LS_KEY); return; }
    const db = await openDB();
    // Only migrate if IndexedDB is empty to avoid duplicates on repeated calls
    const count = await new Promise<number>((res) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).count();
      req.onsuccess = () => res(req.result as number);
      req.onerror  = () => res(0);
    });
    if (count > 0) { localStorage.removeItem(LS_KEY); return; }
    for (const item of items) {
      await new Promise<void>((res) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(item);
        tx.oncomplete = () => res();
        tx.onerror    = () => res(); // skip bad records, don't block
      });
    }
    localStorage.removeItem(LS_KEY);
  } catch { /* ignore — migration is best-effort */ }
}

export async function listProjects(): Promise<ProjectSnapshot[]> {
  if (typeof window === "undefined") return [];
  await migrateFromLocalStorage();
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => {
        const items = (req.result as ProjectSnapshot[]).map((item) => {
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

export async function saveProject(
  snapshot: ProjectSnapshot,
  options: { touchUpdatedAt?: boolean } = {},
): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const getRequest = store.get(snapshot.id);
    getRequest.onsuccess = () => {
      const existing = getRequest.result as ProjectSnapshot | undefined;
      const createdAt = validIsoDate(existing?.createdAt)
        ? existing.createdAt
        : validIsoDate(snapshot.createdAt)
          ? snapshot.createdAt
          : new Date().toISOString();
      const updatedAt = options.touchUpdatedAt === false && validIsoDate(snapshot.updatedAt)
        ? snapshot.updatedAt
        : new Date().toISOString();
      store.put({ ...snapshot, createdAt, updatedAt });
    };
    getRequest.onerror = () => reject(getRequest.error);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

export async function deleteProject(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

export function generateProjectId(): string {
  return `proj-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
