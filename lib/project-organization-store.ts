import { z } from "zod";

export const UNFILED_FOLDER_ID = "folder-unfiled";
const ORGANIZATION_ID = "organization";
export const PROJECT_ORGANIZATION_SCOPE = "projects";
export const SERMON_ORGANIZATION_SCOPE = "sermons";
export type ProjectOrganizationScope =
  | typeof PROJECT_ORGANIZATION_SCOPE
  | typeof SERMON_ORGANIZATION_SCOPE;
const DB_NAMES: Record<ProjectOrganizationScope, string> = {
  [PROJECT_ORGANIZATION_SCOPE]: "nexus-project-organization",
  [SERMON_ORGANIZATION_SCOPE]: "nexus-sermon-organization",
};
const STORE = "organization";

export const ProjectFolderSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  parentId: z.string().min(1).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  sortOrder: z.number().int().nonnegative(),
}).strict();

export const ProjectOrganizationSchema = z.object({
  id: z.literal(ORGANIZATION_ID),
  folders: z.array(ProjectFolderSchema),
  updatedAt: z.string().datetime(),
}).strict();

export type ProjectFolder = z.infer<typeof ProjectFolderSchema>;
export type ProjectOrganization = z.infer<typeof ProjectOrganizationSchema>;

function openDB(scope: ProjectOrganizationScope): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAMES[scope], 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function makeUnfiledFolder(now = new Date().toISOString()): ProjectFolder {
  return {
    id: UNFILED_FOLDER_ID,
    name: "Unfiled",
    parentId: null,
    createdAt: now,
    updatedAt: now,
    sortOrder: 0,
  };
}

export function ensureUnfiledFolder(folders: ProjectFolder[]): ProjectFolder[] {
  if (folders.some((folder) => folder.id === UNFILED_FOLDER_ID)) return folders;
  return [makeUnfiledFolder(), ...folders];
}

export function createProjectOrganization(
  folders: ProjectFolder[] = [],
  updatedAt = new Date().toISOString(),
): ProjectOrganization {
  return {
    id: ORGANIZATION_ID,
    folders: ensureUnfiledFolder(folders),
    updatedAt,
  };
}

export function normalizeProjectFolderId(
  folderId: string | undefined,
  folders: ProjectFolder[],
): string {
  return folderId && folders.some((folder) => folder.id === folderId)
    ? folderId
    : UNFILED_FOLDER_ID;
}

export function removeSyntheticRecoveredFolders(folders: ProjectFolder[]): ProjectFolder[] {
  const removedIds = new Set(
    folders
      .filter((folder) => /^Recovered folder(?: \d+)?$/i.test(folder.name.trim()))
      .map((folder) => folder.id),
  );
  if (removedIds.size === 0) return folders;
  const now = new Date().toISOString();
  return folders
    .filter((folder) => !removedIds.has(folder.id))
    .map((folder) => removedIds.has(folder.parentId ?? "")
      ? { ...folder, parentId: null, updatedAt: now }
      : folder);
}

export async function loadProjectOrganization(
  scope: ProjectOrganizationScope = PROJECT_ORGANIZATION_SCOPE,
): Promise<ProjectOrganization> {
  if (typeof window === "undefined") return createProjectOrganization([], new Date(0).toISOString());
  const db = await openDB(scope);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(ORGANIZATION_ID);
    req.onsuccess = () => {
      const parsed = ProjectOrganizationSchema.safeParse(req.result);
      resolve(parsed.success ? createProjectOrganization(parsed.data.folders, parsed.data.updatedAt) : createProjectOrganization());
    };
    req.onerror = () => reject(req.error);
  });
}

export async function storeProjectOrganization(
  organization: ProjectOrganization,
  scope: ProjectOrganizationScope = PROJECT_ORGANIZATION_SCOPE,
): Promise<void> {
  const parsed = ProjectOrganizationSchema.parse({
    ...organization,
    folders: ensureUnfiledFolder(organization.folders),
  });
  const db = await openDB(scope);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(parsed);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function saveProjectOrganization(
  folders: ProjectFolder[],
  scope: ProjectOrganizationScope = PROJECT_ORGANIZATION_SCOPE,
): Promise<ProjectOrganization> {
  const organization = createProjectOrganization(folders);
  await storeProjectOrganization(organization, scope);
  return organization;
}

export async function fetchProjectOrganizationFromCloud(
  scope: ProjectOrganizationScope = PROJECT_ORGANIZATION_SCOPE,
): Promise<ProjectOrganization | null> {
  const response = await fetch(`/api/project-folders?scope=${scope}`, {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error ?? "Could not load project folders from cloud.");
  }
  const payload = await response.json() as { organization?: unknown | null };
  if (payload.organization === null || payload.organization === undefined) return null;
  const parsed = ProjectOrganizationSchema.safeParse(payload.organization);
  if (!parsed.success) throw new Error("Cloud project folders were invalid.");
  return createProjectOrganization(parsed.data.folders, parsed.data.updatedAt);
}

export async function syncProjectOrganizationToCloud(
  organization: ProjectOrganization,
  scope: ProjectOrganizationScope = PROJECT_ORGANIZATION_SCOPE,
): Promise<ProjectOrganization> {
  const response = await fetch(`/api/project-folders?scope=${scope}`, {
    method: "PUT",
    cache: "no-store",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ organization: ProjectOrganizationSchema.parse(organization) }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error ?? "Could not save project folders to cloud.");
  }

  const savedPayload = await response.json().catch(() => null) as { organization?: unknown } | null;
  const saved = savedPayload?.organization
    ? ProjectOrganizationSchema.safeParse(savedPayload.organization)
    : null;
  if (!saved?.success) {
    throw new Error("Cloud folder storage did not confirm the saved organization.");
  }
  return createProjectOrganization(saved.data.folders, saved.data.updatedAt);
}

export function makeProjectFolder(name: string, parentId: string | null, sortOrder: number): ProjectFolder {
  const now = new Date().toISOString();
  return {
    id: `folder-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: name.trim(),
    parentId,
    createdAt: now,
    updatedAt: now,
    sortOrder,
  };
}

export function flattenProjectFolders(folders: ProjectFolder[]): ProjectFolder[] {
  const result: ProjectFolder[] = [];
  const visited = new Set<string>();
  const visit = (parentId: string | null) => {
    folders
      .filter((folder) => folder.parentId === parentId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
      .forEach((folder) => {
        if (visited.has(folder.id)) return;
        visited.add(folder.id);
        result.push(folder);
        visit(folder.id);
      });
  };
  visit(null);
  folders.forEach((folder) => {
    if (visited.has(folder.id)) return;
    visited.add(folder.id);
    result.push(folder);
    visit(folder.id);
  });
  return result;
}
