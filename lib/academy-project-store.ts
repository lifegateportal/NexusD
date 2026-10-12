import { AcademyPackageSchema } from "@/lib/schemas/academy";
import { AcademyProjectSchema, type AcademyProjectRecord } from "@/lib/schemas/academy-project";
import { SiteConfigSchema } from "@/lib/schemas/site-config";
import type { ProjectSnapshot } from "@/lib/project-store";

export type AcademyProject = AcademyProjectRecord;
export type AcademyProjectSummary = Omit<AcademyProject, "academy" | "siteConfig" | "blueprint" | "logicResult" | "uiResult" | "deliveryInstructions" | "chatHistory"> & {
  academy: null;
  hasAcademy: true;
};

const DB_NAME = "nexus-academy-projects";
const STORE = "projects";
const MIGRATION_KEY = "nexus_academy_projects_migrated_v1";

function validIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

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

function normalizedProject(project: AcademyProject): AcademyProject {
  const createdAt = validIsoDate(project.createdAt)
    ? project.createdAt
    : validIsoDate(project.updatedAt)
      ? project.updatedAt
      : new Date().toISOString();
  return {
    ...project,
    createdAt,
    updatedAt: validIsoDate(project.updatedAt) ? project.updatedAt : createdAt,
  };
}

function summaryProject(project: AcademyProject): AcademyProjectSummary {
  const normalized = normalizedProject(project);
  return {
    id: normalized.id,
    name: normalized.name,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    folderId: normalized.folderId,
    academy: null,
    academyPublishedSlug: normalized.academyPublishedSlug,
    hasAcademy: true,
  };
}

async function putProject(project: AcademyProject): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).put(project);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

function convertLegacyProject(project: ProjectSnapshot): AcademyProject | null {
  if (!project.academy) return null;
  const now = new Date().toISOString();
  const candidate = {
    id: project.id,
    name: project.name,
    createdAt: validIsoDate(project.createdAt) ? project.createdAt : now,
    updatedAt: validIsoDate(project.updatedAt) ? project.updatedAt : now,
    folderId: project.folderId,
    academy: AcademyPackageSchema.parse(project.academy),
    siteConfig: SiteConfigSchema.parse(project.siteConfig ?? {}),
    deliveryInstructions: project.deliveryInstructions ?? "",
    chatHistory: Array.isArray(project.chatHistory) ? project.chatHistory : [],
    blueprint: project.blueprint ?? null,
    logicResult: project.logicResult ?? null,
    uiResult: project.uiResult ?? null,
    academyPublishedSlug: project.academyPublishedSlug,
  };
  return AcademyProjectSchema.parse(candidate);
}

async function migrateLegacyLocalProjects(): Promise<void> {
  if (typeof window === "undefined" || localStorage.getItem(MIGRATION_KEY)) return;
  try {
    const { listProjects } = await import("@/lib/project-store");
    const legacyProjects = await listProjects();
    for (const legacy of legacyProjects) {
      const academy = convertLegacyProject(legacy);
      if (academy) await putProject(academy);
    }
    localStorage.setItem(MIGRATION_KEY, new Date().toISOString());
  } catch {
    // A later load retries the migration if IndexedDB or the legacy store is unavailable.
  }
}

async function migrateLegacyCloudProjects(): Promise<void> {
  if (typeof window === "undefined" || localStorage.getItem(`${MIGRATION_KEY}:cloud`)) return;
  try {
    const response = await fetch("/api/projects?kind=projects&summary=1", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!response.ok) return;
    const payload = await response.json() as { projects?: Array<{ id?: string; hasAcademy?: boolean }> };
    for (const summary of payload.projects ?? []) {
      if (!summary.id || !summary.hasAcademy) continue;
      const detailResponse = await fetch(`/api/projects?id=${encodeURIComponent(summary.id)}`, {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!detailResponse.ok) continue;
      const detail = await detailResponse.json() as { project?: unknown };
      if (!detail.project || typeof detail.project !== "object") continue;
      const academy = convertLegacyProject(detail.project as ProjectSnapshot);
      if (!academy) continue;
      await putProject(academy);
      await fetch("/api/academy/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: academy }),
      });
    }
    localStorage.setItem(`${MIGRATION_KEY}:cloud`, new Date().toISOString());
  } catch {
    // A later load retries the migration if the legacy cloud endpoint is unavailable.
  }
}

export async function listAcademyProjects(): Promise<AcademyProject[]> {
  if (typeof window === "undefined") return [];
  await migrateLegacyLocalProjects();
  await migrateLegacyCloudProjects();
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
    request.onsuccess = () => {
      const projects = (request.result as AcademyProject[])
        .map((project) => normalizedProject(AcademyProjectSchema.parse(project)))
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      resolve(projects);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function listAcademyProjectSummaries(): Promise<AcademyProjectSummary[]> {
  const projects = await listAcademyProjects();
  return projects.map(summaryProject);
}

export async function getAcademyProject(id: string): Promise<AcademyProject | null> {
  if (typeof window === "undefined") return null;
  await migrateLegacyLocalProjects();
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).get(id);
    request.onsuccess = () => {
      const project = request.result as AcademyProject | undefined;
      resolve(project ? normalizedProject(AcademyProjectSchema.parse(project)) : null);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function fetchAcademyProjectFromCloud(id: string): Promise<AcademyProject | null> {
  const response = await fetch(`/api/academy/projects?id=${encodeURIComponent(id)}`, {
    cache: "no-store",
    credentials: "same-origin",
  });
  const payload = await response.json().catch(() => null) as { project?: unknown; error?: string } | null;
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(payload?.error ?? "Could not load the Academy project from cloud.");
  if (!payload?.project || typeof payload.project !== "object") return null;
  return AcademyProjectSchema.parse(payload.project);
}

export async function saveAcademyProject(
  project: AcademyProject,
  options: { touchUpdatedAt?: boolean } = {},
): Promise<void> {
  const existing = await getAcademyProject(project.id);
  const createdAt = validIsoDate(existing?.createdAt)
    ? existing.createdAt
    : validIsoDate(project.createdAt)
      ? project.createdAt
      : new Date().toISOString();
  const updatedAt = options.touchUpdatedAt === false && validIsoDate(project.updatedAt)
    ? project.updatedAt
    : new Date().toISOString();
  await putProject(AcademyProjectSchema.parse({ ...project, createdAt, updatedAt }));
}

export async function deleteAcademyProject(id: string): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

export function generateAcademyProjectId(): string {
  return `academy-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
