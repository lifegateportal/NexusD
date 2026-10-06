"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { NexusNav } from "@/app/components/NexusNav";
import { StatusBar } from "@/app/components/StatusBar";
import { TerminalLog } from "@/app/components/TerminalLog";
import { MediaUpload } from "@/app/components/MediaUpload";
import { ProjectCard } from "@/app/components/ProjectCard";
import { PipelineResults } from "@/app/components/PipelineResults";
import { PromptBar } from "@/app/components/PromptBar";
import { AssistantPanel } from "@/app/components/AssistantPanel";
import { ProjectsPanel } from "@/app/components/ProjectsPanel";
import { EbookPipeline } from "@/app/components/EbookPipeline";
import { SermonAssistantPanel } from "@/app/components/SermonAssistantPanel";
import type { EbookPipelineSnapshot } from "@/app/components/EbookPipeline";
import {
  EbookJobStateSchema,
  EbookTranscriptImportSchema,
  EbookTranscriptSourceSchema,
} from "@/lib/schemas/ebook";
import type {
  EbookManifest,
  EbookTranscriptImport,
  EbookTranscriptSource,
} from "@/lib/schemas/ebook";
import { LogicTransformResultSchema } from "@/lib/schemas/blueprint";
import { UiManifestResultSchema } from "@/lib/schemas/ui-manifest";
import { AcademyPackageSchema } from "@/lib/schemas/academy";
import type { LogicTransformResult } from "@/lib/schemas/blueprint";
import type { UiManifestResult } from "@/lib/schemas/ui-manifest";
import type { AcademyPackage } from "@/lib/schemas/academy";
import type { IngestResult } from "@/lib/schemas/blueprint";
import type { LogEntry, ModelState, ModelHandle, PipelineStage } from "@/lib/types";
import { SiteConfigSchema } from "@/lib/schemas/site-config";
import type { SiteConfig } from "@/lib/schemas/site-config";
import {
  listProjectSummaries,
  getProject,
  fetchProjectFromCloud,
  saveProject,
  deleteProject,
  generateProjectId,
} from "@/lib/project-store";
import {
  listEbookProjectSummaries,
  getEbookProject,
  saveEbookProject,
  deleteEbookProject,
} from "@/lib/ebook-project-store";
import type { ProjectSnapshot, ChatMessage } from "@/lib/project-store";
import {
  loadProjectOrganization,
  loadLatestProjectOrganization,
  makeProjectFolder,
  createProjectOrganization,
  saveProjectOrganization,
  normalizeProjectFolderId,
  removeSyntheticRecoveredFolders,
  storeProjectOrganization,
  fetchProjectOrganizationFromCloud,
  syncProjectOrganizationToCloud,
  UNFILED_FOLDER_ID,
  type ProjectFolder,
} from "@/lib/project-organization-store";

const INITIAL_MODELS: ModelState[] = [
  { name: "Gemini",   handle: "gemini",   role: "Analyst",           status: "standby" },
  { name: "DeepSeek", handle: "deepseek", role: "Engineer",          status: "standby" },
  { name: "Claude",   handle: "claude",   role: "Designer",          status: "standby" },
  { name: "Curator",  handle: "curator",  role: "Academy Producer",  status: "standby" },
  { name: "Manus",    handle: "manus",    role: "Executive",         status: "standby" }
];

export default function HomePage() {
  const router = useRouter();
  const [logs,        setLogs]        = useState<LogEntry[]>([]);
  const [blueprint,   setBlueprint]   = useState<IngestResult | null>(null);
  const [logicResult, setLogicResult] = useState<LogicTransformResult | null>(null);
  const [uiResult,    setUiResult]    = useState<UiManifestResult | null>(null);
  const [academyResult, setAcademyResult] = useState<AcademyPackage | null>(null);
  const [rawTranscript, setRawTranscript] = useState<string>("");
  const [deliveryInstructions, setDeliveryInstructions] = useState<string>("");
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [siteConfig, setSiteConfig] = useState<SiteConfig>(() => SiteConfigSchema.parse({}));
  const [stage,       setStage]       = useState<PipelineStage>("idle");
  const [models,      setModels]      = useState<ModelState[]>(INITIAL_MODELS);
  const [activeNav,   setActiveNav]   = useState("overview");

  // Ebook pipeline state — lifted so the AI assistant can read and edit the book
  const [ebookManifest, setEbookManifest] = useState<EbookManifest | null>(null);
  const [ebookSnapshot, setEbookSnapshot] = useState<EbookPipelineSnapshot | null>(null);
  const [ebookTranscriptImports, setEbookTranscriptImports] = useState<EbookTranscriptImport[]>([]);
  const [ebookImportNotice, setEbookImportNotice] = useState<{ type: "success" | "error"; text: string } | null>(null);
  // Incrementing this remounts <EbookPipeline> so it re-reads localStorage after a project load
  const [ebookPipelineKey, setEbookPipelineKey] = useState(0);

  // Project persistence
  const [projects,        setProjects]        = useState<ProjectSnapshot[]>([]);
  const [currentProjectId, setCurrentProjectId] = useState<string>("");
  const [chatHistory,     setChatHistory]     = useState<ChatMessage[]>([]);
  const [panelLoadKey,    setPanelLoadKey]    = useState<string>("");
  const [folders,         setFolders]         = useState<ProjectFolder[]>([]);
  const [folderSyncError, setFolderSyncError] = useState<string | null>(null);
  const projectsHydratedRef = useRef(false);

  // Load persisted state client-side only (avoids SSR hydration mismatch)
  useEffect(() => {
    try {
      setDeliveryInstructions(localStorage.getItem("nexus_delivery_instructions") ?? "");
      const raw = localStorage.getItem("nexus_site_config");
      if (raw) setSiteConfig(SiteConfigSchema.parse(JSON.parse(raw) as unknown));
    } catch { /* ignore */ }
    if (activeNav !== "projects" || projectsHydratedRef.current) return;
    projectsHydratedRef.current = true;
    void (async () => {
      try {
        let organization = await loadProjectOrganization().catch(() => (
          createProjectOrganization([], new Date(0).toISOString())
        ));
        try {
          const remoteOrganization = await fetchProjectOrganizationFromCloud();
          if (
            remoteOrganization &&
            new Date(remoteOrganization.updatedAt).getTime() > new Date(organization.updatedAt).getTime()
          ) {
            await storeProjectOrganization(remoteOrganization);
            organization = remoteOrganization;
          } else if (!remoteOrganization || new Date(organization.updatedAt).getTime() > new Date(remoteOrganization.updatedAt).getTime()) {
            organization = await syncProjectOrganizationToCloud(organization);
            await storeProjectOrganization(organization);
          }
        } catch (error) {
          setFolderSyncError(error instanceof Error ? error.message : "Could not synchronize folders.");
        }
        const cleanedFolders = removeSyntheticRecoveredFolders(organization.folders);
        if (cleanedFolders.length !== organization.folders.length) {
          organization = await saveProjectOrganization(cleanedFolders);
          try {
            organization = await syncProjectOrganizationToCloud(organization);
            await storeProjectOrganization(organization);
          } catch (error) {
            setFolderSyncError(error instanceof Error ? error.message : "Could not synchronize cleaned folders.");
          }
        }
        setFolders(organization.folders);

        const main = await listProjectSummaries();
        const mainIds = new Set(main.map((p) => p.id));
        const ebookLocal = await listEbookProjectSummaries().catch(() => []);
        const ebookOnly = ebookLocal
          .filter((e) => !mainIds.has(e.id))
          .map((e) => ({
            id: e.id,
            name: e.name,
            createdAt: e.createdAt,
            updatedAt: e.updatedAt,
            academy: null,
            siteConfig: SiteConfigSchema.parse({}),
            deliveryInstructions: "",
            chatHistory: [],
            blueprint: null,
            logicResult: null,
            uiResult: null,
            ebookManifest: null,
            ebookJobState: e.jobState,
            folderId: e.folderId,
            publishedSlug: e.publishedSlug,
            coverImageUrl: e.coverImageUrl,
            authorImageUrl: e.authorImageUrl,
          }));
        const mergedLocal = [...main, ...ebookOnly];
        const normalizedLocal = mergedLocal.map((project) => ({
          ...project,
          folderId: normalizeProjectFolderId(project.folderId, organization.folders),
        }));
        for (const project of normalizedLocal) {
          const storedProject = mergedLocal.find((existing) => existing.id === project.id);
          if (storedProject?.folderId !== project.folderId) {
            if (mainIds.has(project.id)) {
              const fullProject = await getProject(project.id).catch(() => null);
              if (fullProject) {
                await saveProject({ ...fullProject, folderId: project.folderId }, { touchUpdatedAt: false }).catch(() => {});
              }
            } else {
              const ebookProject = await getEbookProject(project.id).catch(() => null);
              if (ebookProject) {
                await saveEbookProject({
                  ...ebookProject,
                  folderId: UNFILED_FOLDER_ID,
                }, { touchUpdatedAt: false }).catch(() => {});
              }
            }
          }
        }
        setProjects(normalizedLocal);

        // ── Background R2 bidirectional sync ──────────────────────────────
        void (async () => {
          try {
            const r2res = await fetch("/api/projects?kind=projects&summary=1", {
              cache: "no-store",
              credentials: "same-origin",
            });
            if (!r2res.ok) return;
            const {
              projects: r2projects,
              deletedProjectIds = [],
            } = await r2res.json() as { projects: ProjectSnapshot[]; deletedProjectIds?: string[] };
            const deletedIds = new Set(deletedProjectIds);
            if (deletedIds.size > 0) {
              for (const id of deletedIds) {
                await deleteProject(id).catch(() => {});
                await deleteEbookProject(id).catch(() => {});
              }
            }
            const activeLocal = mergedLocal.filter((project) => !deletedIds.has(project.id));
            if (deletedIds.size > 0) setProjects(activeLocal);
            if (!Array.isArray(r2projects) || r2projects.length === 0) {
              // R2 is empty — push all local projects up (initial upload)
              for (const p of activeLocal) {
                const fullProject = await getProject(p.id).catch(() => null)
                  ?? await getEbookProject(p.id).then((ebookProject) => ebookProject ? {
                    id: ebookProject.id,
                    name: ebookProject.name,
                    createdAt: ebookProject.createdAt,
                    updatedAt: ebookProject.updatedAt,
                    folderId: ebookProject.folderId,
                    academy: null,
                    siteConfig: SiteConfigSchema.parse({}),
                    deliveryInstructions: "",
                    chatHistory: [],
                    blueprint: null,
                    logicResult: null,
                    uiResult: null,
                    ebookManifest: null,
                    ebookJobState: ebookProject.jobState,
                    publishedSlug: ebookProject.publishedSlug,
                    coverImageUrl: ebookProject.coverImageUrl,
                    authorImageUrl: ebookProject.authorImageUrl,
                  } satisfies ProjectSnapshot : null).catch(() => null);
                if (!fullProject) continue;
                await fetch("/api/projects", {
                  method: "POST", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ project: fullProject }),
                }).catch(() => {});
              }
              return;
            }
            const r2ById  = new Map(r2projects.map((p: ProjectSnapshot) => [p.id, p]));
            const localById = new Map(activeLocal.map((p) => [p.id, p]));
            const toPushR2: ProjectSnapshot[] = [];
            // Push: local has newer or unknown project
            for (const localP of activeLocal) {
              const r2p = r2ById.get(localP.id);
              if (!r2p || new Date(localP.updatedAt) > new Date((r2p as ProjectSnapshot).updatedAt)) {
                const fullLocal = await getProject(localP.id).catch(() => null)
                  ?? await getEbookProject(localP.id).then((ebookProject) => ebookProject ? {
                    id: ebookProject.id,
                    name: ebookProject.name,
                    createdAt: ebookProject.createdAt,
                    updatedAt: ebookProject.updatedAt,
                    folderId: ebookProject.folderId,
                    academy: null,
                    siteConfig: SiteConfigSchema.parse({}),
                    deliveryInstructions: "",
                    chatHistory: [],
                    blueprint: null,
                    logicResult: null,
                    uiResult: null,
                    ebookManifest: null,
                    ebookJobState: ebookProject.jobState,
                    publishedSlug: ebookProject.publishedSlug,
                    coverImageUrl: ebookProject.coverImageUrl,
                    authorImageUrl: ebookProject.authorImageUrl,
                  } satisfies ProjectSnapshot : null).catch(() => null);
                if (fullLocal) toPushR2.push(fullLocal);
              }
            }
            for (const p of toPushR2) {
              await fetch("/api/projects", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ project: p }),
              }).catch(() => {});
            }
            const mergedById = new Map(activeLocal.map((project) => [project.id, project]));
            for (const remoteProject of r2projects) {
              const localProject = localById.get(remoteProject.id);
              if (!localProject || new Date(remoteProject.updatedAt) >= new Date(localProject.updatedAt)) {
                mergedById.set(remoteProject.id, {
                  id: remoteProject.id,
                  name: remoteProject.name,
                  createdAt: remoteProject.createdAt,
                  updatedAt: remoteProject.updatedAt,
                  folderId: normalizeProjectFolderId(remoteProject.folderId, organization.folders),
                  academy: null,
                  siteConfig: SiteConfigSchema.parse({}),
                  deliveryInstructions: "",
                  chatHistory: [],
                  blueprint: null,
                  logicResult: null,
                  uiResult: null,
                  ebookManifest: null,
                  ebookJobState: null,
                  publishedSlug: remoteProject.publishedSlug,
                  coverImageUrl: remoteProject.coverImageUrl,
                  authorImageUrl: remoteProject.authorImageUrl,
                  hasAcademy: remoteProject.hasAcademy,
                  hasEbookContent: remoteProject.hasEbookContent,
                  ebookChapterCount: remoteProject.ebookChapterCount,
                  ebookTotalWordCount: remoteProject.ebookTotalWordCount,
                  ebookStatus: remoteProject.ebookStatus,
                });
              }
            }
            setProjects(Array.from(mergedById.values()).sort(
              (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
            ));
          } catch { /* R2 sync is best-effort */ }
        })();
      } catch { /* ignore */ }
    })();
  }, [activeNav]);

  // Populate boot logs client-side only to avoid server/client timestamp mismatch.
  useEffect(() => {
    const now = new Date().toISOString();
    setLogs([
      { id: "sys-1", level: "init",    message: "Nexus Director shell online",                    timestamp: now },
      { id: "sys-2", level: "init",    message: "5-agent pipeline staged: Analyst → Engineer → Designer → Curator → Executive", timestamp: now },
      { id: "sys-3", level: "success", message: "Dynamic viewport lock enforced (dvh + safe-area)", timestamp: now }
    ]);
  }, []);

  const addLog = useCallback((entry: Omit<LogEntry, "id" | "timestamp">) => {
    const id = `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setLogs((prev) => [...prev, { ...entry, id, timestamp: new Date().toISOString() }]);

    if (entry.model !== undefined) {
      const handle: ModelHandle = entry.model;
      setModels((prev) =>
        prev.map((m) =>
          m.handle === handle
            ? {
                ...m,
                status:
                  entry.level === "error"   ? "error"   :
                  entry.level === "success" ? "standby" : "active"
              }
            : m
        )
      );
    }
  }, []);

  const handleAssistantUpdate = useCallback((updated: AcademyPackage, summary: string) => {
    setAcademyResult(updated);
    localStorage.setItem("nexus_academy_preview", JSON.stringify(updated));
    addLog({ level: "success", message: `Director: ${summary}`, model: "curator" });
  }, [addLog]);

  const handleSiteUpdate = useCallback((config: SiteConfig, summary: string) => {
    setSiteConfig(config);
    localStorage.setItem("nexus_site_config", JSON.stringify(config));
    addLog({ level: "success", message: `Director: ${summary}`, model: "curator" });
  }, [addLog]);

  // Keep ebookManifest in sync whenever the ebook pipeline finishes or is edited
  const handleEbookManifestReady = useCallback((manifest: EbookManifest) => {
    setEbookManifest(manifest);
  }, []);

  const EBOOK_JOB_KEY = "nexus_ebook_job_state";
  const EBOOK_PENDING_MOUNT_KEY = "nexus_ebook_pending_mount";

  const handleSaveProject = useCallback(async (name: string, folderId?: string) => {
    const id = currentProjectId || generateProjectId();
    const existingProject = projects.find((p) => p.id === id);
    const existingEbookProject = await getEbookProject(id).catch(() => null);
    // Read the live ebook job state from localStorage (pipeline auto-saves there)
    let ebookJobState = null;
    try {
      const raw = localStorage.getItem(EBOOK_JOB_KEY);
      if (raw) ebookJobState = EbookJobStateSchema.parse(JSON.parse(raw) as unknown);
    } catch { /* ignore — job state is optional */ }
    const snapshot: ProjectSnapshot = {
      id,
      name,
      createdAt: currentProjectId ? (projects.find((p) => p.id === id)?.createdAt ?? new Date().toISOString()) : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      folderId: existingProject?.folderId ?? existingEbookProject?.folderId ?? folderId ?? UNFILED_FOLDER_ID,
      academy: academyResult,
      siteConfig,
      deliveryInstructions,
      chatHistory,
      blueprint: blueprint ?? null,
      logicResult: logicResult ?? null,
      uiResult: uiResult ?? null,
      ebookManifest: ebookManifest ?? null,
      ebookJobState: ebookJobState ?? undefined,
      publishedSlug: existingProject?.publishedSlug ?? existingEbookProject?.publishedSlug,
      coverImageUrl: existingProject?.coverImageUrl ?? existingEbookProject?.coverImageUrl,
      authorImageUrl: existingProject?.authorImageUrl ?? existingEbookProject?.authorImageUrl,
    };
    try {
      await saveProject(snapshot);
      if (ebookJobState) {
        await saveEbookProject({
          id,
          name,
          createdAt: snapshot.createdAt,
          updatedAt: snapshot.updatedAt,
          folderId: snapshot.folderId,
          bookTitle: ebookJobState.architecture?.bookTitle ?? name,
          chapterCount: ebookJobState.chapters?.length ?? 0,
          totalWordCount: (ebookJobState.chapters ?? []).reduce((sum, chapter) => sum + (chapter.totalWordCount ?? 0), 0),
          status: ebookJobState.status,
          jobState: ebookJobState,
          publishedSlug: snapshot.publishedSlug,
          coverImageUrl: snapshot.coverImageUrl,
          authorImageUrl: snapshot.authorImageUrl,
        }).catch(() => {});
      }
      setCurrentProjectId(id);
      const main = await listProjectSummaries();
      const mainIds = new Set(main.map((p) => p.id));
      const ebookOnly = (await listEbookProjectSummaries().catch(() => []))
        .filter((e) => !mainIds.has(e.id))
        .map((e) => ({
          id: e.id,
          name: e.name,
          createdAt: e.createdAt,
          updatedAt: e.updatedAt,
          academy: null,
          siteConfig: SiteConfigSchema.parse({}),
          deliveryInstructions: "",
          chatHistory: [],
          blueprint: null,
          logicResult: null,
          uiResult: null,
          ebookManifest: null,
          ebookJobState: e.jobState,
          folderId: e.folderId,
          publishedSlug: e.publishedSlug,
          coverImageUrl: e.coverImageUrl,
          authorImageUrl: e.authorImageUrl,
        }));
      setProjects([...main, ...ebookOnly]);
      addLog({ level: "success", message: `Project "${name}" saved.` });
      // Sync to R2 (fire-and-forget)
      fetch("/api/projects", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: snapshot }),
      }).catch(() => {});
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Save failed";
      addLog({ level: "error", message: `Could not save project: ${msg}` });
    }
  }, [currentProjectId, projects, academyResult, siteConfig, deliveryInstructions, chatHistory, blueprint, logicResult, uiResult, ebookManifest, addLog]);

  const persistProjectFolderChanges = useCallback(async (changes: Record<string, string>) => {
    for (const project of projects) {
      const folderId = changes[project.id];
      if (!folderId) continue;
      const fullProject = await getProject(project.id).catch(() => null);
      if (fullProject) {
        const updated = { ...fullProject, folderId };
        await saveProject(updated, { touchUpdatedAt: false });
        await fetch("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ project: updated }),
        });
        continue;
      }
      const remoteProject = await fetchProjectFromCloud(project.id).catch(() => null);
      if (remoteProject) {
        const updated = { ...remoteProject, folderId };
        await saveProject(updated, { touchUpdatedAt: false });
        await fetch("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ project: updated }),
        });
        continue;
      }
      const ebookProject = await getEbookProject(project.id).catch(() => null);
      if (!ebookProject) continue;
      const updatedEbook = { ...ebookProject, folderId };
      await saveEbookProject(updatedEbook, { touchUpdatedAt: false });
      await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: {
            id: updatedEbook.id,
            name: updatedEbook.name,
            createdAt: updatedEbook.createdAt,
            updatedAt: updatedEbook.updatedAt,
            folderId: updatedEbook.folderId,
            academy: null,
            siteConfig: {},
            deliveryInstructions: "",
            chatHistory: [],
            blueprint: null,
            logicResult: null,
            uiResult: null,
            ebookManifest: null,
            ebookJobState: updatedEbook.jobState,
            publishedSlug: updatedEbook.publishedSlug,
            coverImageUrl: updatedEbook.coverImageUrl,
            authorImageUrl: updatedEbook.authorImageUrl,
          },
        }),
      });
    }
    setProjects((current) => current.map((project) => (
      changes[project.id] ? { ...project, folderId: changes[project.id] } : project
    )));
  }, [projects]);

  const handleCreateFolder = useCallback(async (name: string, parentId: string | null) => {
    try {
      const organization = await loadLatestProjectOrganization();
      if (organization.folders.some((folder) => folder.parentId === parentId && folder.name.toLowerCase() === name.toLowerCase())) {
        throw new Error("A folder with that name already exists here.");
      }
      const sortOrder = organization.folders.filter((folder) => folder.parentId === parentId).length;
      const next = await saveProjectOrganization([
        ...organization.folders,
        makeProjectFolder(name, parentId, sortOrder),
      ]);
      setFolders(next.folders);
      const confirmed = await syncProjectOrganizationToCloud(next);
      await storeProjectOrganization(confirmed);
      setFolders(confirmed.folders);
      setFolderSyncError(null);
    } catch (error) {
      setFolderSyncError(error instanceof Error ? error.message : "Could not create folder.");
      addLog({ level: "error", message: error instanceof Error ? error.message : "Could not create folder." });
    }
  }, [addLog]);

  const handleRenameFolder = useCallback(async (id: string, name: string) => {
    try {
      const organization = await loadLatestProjectOrganization();
      const folder = organization.folders.find((item) => item.id === id);
      if (!folder || id === UNFILED_FOLDER_ID) return;
      if (organization.folders.some((item) => item.id !== id && item.parentId === folder.parentId && item.name.toLowerCase() === name.toLowerCase())) {
        throw new Error("A folder with that name already exists here.");
      }
      const now = new Date().toISOString();
      const next = await saveProjectOrganization(organization.folders.map((item) => (
        item.id === id ? { ...item, name: name.trim(), updatedAt: now } : item
      )));
      setFolders(next.folders);
      const confirmed = await syncProjectOrganizationToCloud(next);
      await storeProjectOrganization(confirmed);
      setFolders(confirmed.folders);
      setFolderSyncError(null);
    } catch (error) {
      setFolderSyncError(error instanceof Error ? error.message : "Could not rename folder.");
      addLog({ level: "error", message: error instanceof Error ? error.message : "Could not rename folder." });
    }
  }, [addLog]);

  const handleDeleteFolder = useCallback(async (id: string) => {
    if (id === UNFILED_FOLDER_ID || !window.confirm("Delete this folder? Projects inside it will move to Unfiled.")) return;
    try {
      const organization = await loadLatestProjectOrganization();
      const folder = organization.folders.find((item) => item.id === id);
      if (!folder) return;
      const now = new Date().toISOString();
      const next = await saveProjectOrganization(
        organization.folders
          .filter((item) => item.id !== id)
          .map((item) => item.parentId === id ? { ...item, parentId: folder.parentId, updatedAt: now } : item),
      );
      setFolders(next.folders);
      const changes = projects.reduce<Record<string, string>>((result, project) => {
        if ((project.folderId ?? UNFILED_FOLDER_ID) === id) result[project.id] = UNFILED_FOLDER_ID;
        return result;
      }, {});
      await persistProjectFolderChanges(changes);
      const confirmed = await syncProjectOrganizationToCloud(next);
      await storeProjectOrganization(confirmed);
      setFolders(confirmed.folders);
      setFolderSyncError(null);
    } catch (error) {
      setFolderSyncError(error instanceof Error ? error.message : "Could not delete folder.");
      addLog({ level: "error", message: error instanceof Error ? error.message : "Could not delete folder." });
    }
  }, [addLog, persistProjectFolderChanges, projects]);

  const handleMoveProject = useCallback(async (id: string, folderId: string) => {
    if (!folders.some((folder) => folder.id === folderId)) return;
    try {
      await persistProjectFolderChanges({ [id]: folderId });
    } catch (error) {
      addLog({ level: "error", message: error instanceof Error ? error.message : "Could not move project." });
    }
  }, [addLog, folders, persistProjectFolderChanges]);

  const handleLoadProject = useCallback(async (id: string) => {
    const summary = projects.find((proj) => proj.id === id);
    if (!summary) return;
    const p = await getProject(id).catch(() => null)
      ?? await fetchProjectFromCloud(id).catch(() => null)
      ?? await (async () => {
      const ebookProject = await getEbookProject(id).catch(() => null);
      if (!ebookProject) return null;
      return {
        id: ebookProject.id,
        name: ebookProject.name,
        createdAt: ebookProject.createdAt,
        updatedAt: ebookProject.updatedAt,
        folderId: ebookProject.folderId,
        academy: null,
        siteConfig: SiteConfigSchema.parse({}),
        deliveryInstructions: "",
        chatHistory: [],
        blueprint: null,
        logicResult: null,
        uiResult: null,
        ebookManifest: null,
        ebookJobState: ebookProject.jobState,
        publishedSlug: ebookProject.publishedSlug,
        coverImageUrl: ebookProject.coverImageUrl,
        authorImageUrl: ebookProject.authorImageUrl,
      } satisfies ProjectSnapshot;
      })();
    if (!p) return;
    const legacyJobState = (p as ProjectSnapshot & { jobState?: unknown }).jobState;
    const rawEbookJobState = p.ebookJobState ?? legacyJobState;
    const decodedEbookJobState = (() => {
      if (!rawEbookJobState) return null;
      let value: unknown = rawEbookJobState;
      for (let i = 0; i < 3 && typeof value === "string"; i++) {
        try {
          value = JSON.parse(value) as unknown;
        } catch {
          return null;
        }
      }
      return value;
    })();
    const parsedEbookJobState = decodedEbookJobState
      ? EbookJobStateSchema.safeParse(decodedEbookJobState)
      : null;
    const synthesizedFromManifest = (() => {
      if (!p.ebookManifest) return null;
      const nowIso = new Date().toISOString();
      return {
        jobId: p.ebookManifest.jobId || p.id,
        status: "complete",
        audioFileNames: [],
        transcripts: [],
        masterTranscript: "",
        filteredTranscript: "",
        filterRemovedCount: 0,
        voiceDNA: p.ebookManifest.voiceDNA ?? null,
        contentMap: {
          totalEstimatedWords: p.ebookManifest.totalWordCount,
          overarchingThemes: [],
          teachingArc: "",
          coreThesis: "",
          targetAudience: "",
          uniqueVocabulary: [],
          toneMap: "",
          segments: [],
          allQuotes: p.ebookManifest.allQuotes ?? [],
        },
        architecture: {
          bookTitle: p.ebookManifest.bookTitle,
          subtitle: p.ebookManifest.subtitle,
          authorName: p.ebookManifest.authorName,
          estimatedTotalWords: p.ebookManifest.totalWordCount,
          chapters: [],
          frontMatterNotes: "",
          backMatterNotes: "",
          seriesArc: [],
          droppedSegments: [],
        },
        sectionAssignments: [],
        sections: [],
        chapters: p.ebookManifest.chapters ?? [],
        frontMatter: p.ebookManifest.frontMatter,
        backMatter: p.ebookManifest.backMatter ?? null,
        exportUrls: null,
        currentStage: "complete",
        progress: {
          total: p.ebookManifest.chapters?.length ?? 0,
          completed: p.ebookManifest.chapters?.length ?? 0,
        },
        errorLog: [],
        createdAt: p.createdAt ?? nowIso,
        updatedAt: p.updatedAt ?? nowIso,
      };
    })();
    const parsedManifestJobState = synthesizedFromManifest
      ? EbookJobStateSchema.safeParse(synthesizedFromManifest)
      : null;
    const loadableEbookJobState = parsedEbookJobState?.success
      ? parsedEbookJobState.data
      : parsedManifestJobState?.success
        ? parsedManifestJobState.data
        : null;
    setBlueprint(p.blueprint);
    setLogicResult(p.logicResult);
    setUiResult(p.uiResult);
    setAcademyResult(p.academy);
    setSiteConfig(SiteConfigSchema.parse(p.siteConfig ?? {}));
    setDeliveryInstructions(p.deliveryInstructions ?? "");
    setChatHistory(Array.isArray(p.chatHistory) ? p.chatHistory : []);
    setPanelLoadKey(p.id);
    setCurrentProjectId(p.id);
    setEbookManifest(p.ebookManifest ?? null);
    // Restore full ebook pipeline state so the pipeline can resume from where it left off
    if (loadableEbookJobState) {
      try {
        localStorage.setItem(EBOOK_JOB_KEY, JSON.stringify(loadableEbookJobState));
        localStorage.setItem(EBOOK_PENDING_MOUNT_KEY, JSON.stringify({
          projectId: p.id,
          projectName: p.name,
          jobState: loadableEbookJobState,
          ebookManifest: p.ebookManifest ?? null,
          coverImageUrl: p.coverImageUrl ?? null,
          authorImageUrl: p.authorImageUrl ?? null,
          ts: Date.now(),
        }));
        setEbookPipelineKey((k) => k + 1); // remount pipeline to pick up restored state
      } catch { /* ignore quota errors */ }
    }
    if (p.blueprint) setStage("done");
    // Navigate to ebook tab if the project has a book; otherwise overview
    if (loadableEbookJobState) {
      router.push(`/ebook?tab=pipeline&load=${encodeURIComponent(p.id)}`);
    } else if (p.ebookManifest) {
      addLog({ level: "warn", message: `Project "${p.name}" has no resumable ebook job state.` });
      router.push(`/ebook?tab=pipeline&load=${encodeURIComponent(p.id)}`);
    } else {
      setActiveNav("overview");
    }
    // Update the shared localStorage keys so preview pages also see the loaded data
    if (p.academy) localStorage.setItem("nexus_academy_preview", JSON.stringify(p.academy));
    localStorage.setItem("nexus_site_config", JSON.stringify(p.siteConfig));
    localStorage.setItem("nexus_delivery_instructions", p.deliveryInstructions);
    addLog({ level: "success", message: `Project "${p.name}" loaded.` });
  }, [projects, addLog, router]);

  const handleExportProject = useCallback(async (id: string): Promise<ProjectSnapshot | null> => {
    const local = await getProject(id).catch(() => null);
    if (local) return local;
    return fetchProjectFromCloud(id).catch(() => null);
  }, []);

  useEffect(() => {
    if (activeNav === "ebook") {
      router.replace("/ebook?tab=pipeline");
    }
  }, [activeNav, router]);

  const handleDeleteProject = useCallback(async (id: string) => {
    await deleteProject(id);
    await deleteEbookProject(id).catch(() => {});
    const main = await listProjectSummaries();
    const mainIds = new Set(main.map((p) => p.id));
    const ebookOnly = (await listEbookProjectSummaries().catch(() => []))
      .filter((e) => !mainIds.has(e.id))
      .map((e) => ({
        id: e.id,
        name: e.name,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
        academy: null,
        siteConfig: SiteConfigSchema.parse({}),
        deliveryInstructions: "",
        chatHistory: [],
        blueprint: null,
        logicResult: null,
        uiResult: null,
        ebookManifest: null,
        ebookJobState: e.jobState,
        folderId: e.folderId,
        publishedSlug: e.publishedSlug,
        coverImageUrl: e.coverImageUrl,
        authorImageUrl: e.authorImageUrl,
      }));
    setProjects([...main, ...ebookOnly]);
    if (currentProjectId === id) setCurrentProjectId("");
    try {
      const response = await fetch("/api/projects", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error ?? "Cloud deletion failed.");
      }
    } catch (error) {
      addLog({
        level: "error",
        message: `Project removed locally, but cloud deletion failed: ${error instanceof Error ? error.message : "try again before reloading."}`,
      });
    }
  }, [addLog, currentProjectId]);

  const handleImportProject = useCallback(async (snapshot: ProjectSnapshot) => {
    const importedSnapshot = {
      ...snapshot,
      folderId: snapshot.folderId && folders.some((folder) => folder.id === snapshot.folderId)
        ? snapshot.folderId
        : UNFILED_FOLDER_ID,
    };
    await saveProject(importedSnapshot);
    if (importedSnapshot.ebookJobState) {
      await saveEbookProject({
        id: importedSnapshot.id,
        name: importedSnapshot.name,
        createdAt: importedSnapshot.createdAt,
        updatedAt: importedSnapshot.updatedAt,
        bookTitle: importedSnapshot.ebookJobState.architecture?.bookTitle ?? importedSnapshot.name,
        chapterCount: importedSnapshot.ebookJobState.chapters?.length ?? 0,
        totalWordCount: (importedSnapshot.ebookJobState.chapters ?? []).reduce((sum, chapter) => sum + (chapter.totalWordCount ?? 0), 0),
        status: importedSnapshot.ebookJobState.status,
        jobState: importedSnapshot.ebookJobState,
        folderId: importedSnapshot.folderId,
        publishedSlug: importedSnapshot.publishedSlug,
        coverImageUrl: importedSnapshot.coverImageUrl,
        authorImageUrl: importedSnapshot.authorImageUrl,
      }).catch(() => {});
    }
    const main = await listProjectSummaries();
    const mainIds = new Set(main.map((p) => p.id));
    const ebookOnly = (await listEbookProjectSummaries().catch(() => []))
      .filter((e) => !mainIds.has(e.id))
      .map((e) => ({
        id: e.id,
        name: e.name,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
        academy: null,
        siteConfig: SiteConfigSchema.parse({}),
        deliveryInstructions: "",
        chatHistory: [],
        blueprint: null,
        logicResult: null,
        uiResult: null,
        ebookManifest: null,
        ebookJobState: e.jobState,
        folderId: e.folderId,
        publishedSlug: e.publishedSlug,
        coverImageUrl: e.coverImageUrl,
        authorImageUrl: e.authorImageUrl,
      }));
    setProjects([...main, ...ebookOnly]);
    addLog({ level: "success", message: `Project "${importedSnapshot.name}" imported.` });
    fetch("/api/projects", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: importedSnapshot }),
    }).catch(() => {});
  }, [addLog, folders]);

  const handlePublishProject = useCallback(async (snapshot: ProjectSnapshot): Promise<string | null> => {
    const fullSnapshot = await getProject(snapshot.id).catch(() => null)
      ?? await fetchProjectFromCloud(snapshot.id).catch(() => null);
    if (!fullSnapshot) {
      addLog({ level: "error", message: "The project content could not be loaded for publishing." });
      return null;
    }
    const job = fullSnapshot.ebookJobState;
    const manifest = fullSnapshot.ebookManifest;
    if (!job?.architecture && !manifest) {
      addLog({ level: "error", message: "No ebook content found — run the ebook pipeline first." });
      return null;
    }
    // Always prefer job.chapters (fresher — includes premiseLine, latest edits) over manifest.chapters.
    // Never filter by status: a chapter that finished writing but isn't "complete" would be silently dropped.
    const jobChapters = job?.chapters?.length ? job.chapters : undefined;
    const publishManifest = manifest
      ? {
          ...manifest,
          chapters: jobChapters ?? manifest.chapters,
          frontMatter: job?.frontMatter ?? manifest.frontMatter,
        }
      : {
          jobId:         job!.jobId,
          bookTitle:     job!.architecture!.bookTitle,
          subtitle:      job!.architecture!.subtitle,
          authorName:    job!.architecture!.authorName,
          frontMatter:   job!.frontMatter,
          chapters:      job!.chapters ?? [],
          totalWordCount: (job!.chapters ?? []).reduce((s: number, c: { totalWordCount?: number }) => s + (c.totalWordCount ?? 0), 0),
          allQuotes:     job!.contentMap?.allQuotes ?? [],
          generatedAt:   job!.updatedAt ?? new Date().toISOString(),
          selectedTemplate: "devotional",
          printSpec:     { trimSize: "6x9", runningHeaders: true, folioStyle: "center", frontMatterNumbering: "arabic", sectionOrnament: "rule" },
        };
    const body = {
      manifest: publishManifest,
      coverAccent: "amber",
      ...(fullSnapshot.coverImageUrl  ? { coverImageUrl:  fullSnapshot.coverImageUrl  } : {}),
      ...(fullSnapshot.authorImageUrl ? { authorImageUrl: fullSnapshot.authorImageUrl } : {}),
    };
    try {
      const res = await fetch("/api/ebook/publish", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json() as { error?: string };
        addLog({ level: "error", message: err.error ?? "Publish failed." });
        return null;
      }
      const { slug } = await res.json() as { slug: string };
      await saveProject({ ...fullSnapshot, publishedSlug: slug });
      // Also update the ebook store so /ebook panel shows View in Library / Republish
      const ep = await getEbookProject(snapshot.id).catch(() => null);
      if (ep) await saveEbookProject({ ...ep, publishedSlug: slug }).catch(() => {});
      // Reload merged project list
      const freshMain = await listProjectSummaries();
      const freshMainIds = new Set(freshMain.map((p) => p.id));
      const freshEbook = (await listEbookProjectSummaries().catch(() => [])).filter((e) => !freshMainIds.has(e.id)).map((e) => ({
        id: e.id, name: e.name, createdAt: e.createdAt, updatedAt: e.updatedAt,
        academy: null, siteConfig: SiteConfigSchema.parse({}), deliveryInstructions: "",
        chatHistory: [], blueprint: null, logicResult: null, uiResult: null,
        ebookManifest: null, ebookJobState: e.jobState, publishedSlug: e.publishedSlug,
        folderId: e.folderId,
      }));
      setProjects([...freshMain, ...freshEbook]);
      addLog({ level: "success", message: `Published to /library/${slug}` });
      // Sync updated publishedSlug to R2
      fetch("/api/projects", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: { ...fullSnapshot, publishedSlug: slug } }),
      }).catch(() => {});
      return slug;
    } catch (err) {
      addLog({ level: "error", message: err instanceof Error ? err.message : "Publish failed." });
      return null;
    }
  }, [addLog]);

  const handleUpdateImages = useCallback(async (id: string, coverImageUrl?: string, authorImageUrl?: string) => {
    const p = await getProject(id).catch(() => null)
      ?? await fetchProjectFromCloud(id).catch(() => null);
    if (!p) return;
    const updated: ProjectSnapshot = {
      ...p,
      ...(coverImageUrl  !== undefined ? { coverImageUrl  } : {}),
      ...(authorImageUrl !== undefined ? { authorImageUrl } : {}),
    };
    await saveProject(updated);
    const ep = await getEbookProject(id).catch(() => null);
    if (ep) {
      await saveEbookProject({
        ...ep,
        ...(coverImageUrl !== undefined ? { coverImageUrl } : {}),
        ...(authorImageUrl !== undefined ? { authorImageUrl } : {}),
      }).catch(() => {});
    }
    const main = await listProjectSummaries();
    const mainIds = new Set(main.map((p) => p.id));
    const ebookOnly = (await listEbookProjectSummaries().catch(() => []))
      .filter((e) => !mainIds.has(e.id))
      .map((e) => ({
        id: e.id,
        name: e.name,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
        academy: null,
        siteConfig: SiteConfigSchema.parse({}),
        deliveryInstructions: "",
        chatHistory: [],
        blueprint: null,
        logicResult: null,
        uiResult: null,
        ebookManifest: null,
        ebookJobState: e.jobState,
        folderId: e.folderId,
        publishedSlug: e.publishedSlug,
        coverImageUrl: e.coverImageUrl,
        authorImageUrl: e.authorImageUrl,
      }));
    setProjects([...main, ...ebookOnly]);
    fetch("/api/projects", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: updated }),
    }).catch(() => {});
    // If already published, push the new images to the library immediately
    if (updated.publishedSlug) {
      handlePublishProject(updated).catch(() => {});
    }
  }, [handlePublishProject]);

  const handleUnpublishProject = useCallback(async (snapshot: ProjectSnapshot): Promise<boolean> => {
    const fullSnapshot = await getProject(snapshot.id).catch(() => null)
      ?? await fetchProjectFromCloud(snapshot.id).catch(() => null);
    if (!fullSnapshot?.publishedSlug) return false;
    try {
      const res = await fetch("/api/ebook/publish", {
        method:  "DELETE",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ slug: fullSnapshot.publishedSlug }),
      });
      if (!res.ok) {
        const err = await res.json() as { error?: string };
        addLog({ level: "error", message: err.error ?? "Unpublish failed." });
        return false;
      }
      // Clear publishedSlug from both stores
      await saveProject({ ...fullSnapshot, publishedSlug: undefined });
      const ep = await getEbookProject(snapshot.id).catch(() => null);
      if (ep) await saveEbookProject({ ...ep, publishedSlug: undefined }).catch(() => {});
      // Refresh project list
      const main = await listProjectSummaries();
      const mainIds = new Set(main.map((p) => p.id));
      const ebookOnly = (await listEbookProjectSummaries().catch(() => []))
        .filter((e) => !mainIds.has(e.id))
        .map((e) => ({
          id: e.id,
          name: e.name,
          createdAt: e.createdAt,
          updatedAt: e.updatedAt,
          academy: null,
          siteConfig: SiteConfigSchema.parse({}),
          deliveryInstructions: "",
          chatHistory: [],
          blueprint: null,
          logicResult: null,
          uiResult: null,
          ebookManifest: null,
          ebookJobState: e.jobState,
          folderId: e.folderId,
          publishedSlug: e.publishedSlug,
          coverImageUrl: e.coverImageUrl,
          authorImageUrl: e.authorImageUrl,
        }));
      setProjects([...main, ...ebookOnly]);
      addLog({ level: "success", message: `"${snapshot.name}" removed from library.` });
      // Sync cleared publishedSlug to R2
      fetch("/api/projects", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: { ...fullSnapshot, publishedSlug: undefined } }),
      }).catch(() => {});
      return true;
    } catch (err) {
      addLog({ level: "error", message: err instanceof Error ? err.message : "Unpublish failed." });
      return false;
    }
  }, [addLog]);

  const handleStageChange = useCallback((s: PipelineStage) => {
    setStage(s);
    if (s === "done" || s === "error" || s === "idle") {
      setModels((prev) => prev.map((m) => ({ ...m, status: "standby" })));
    }
  }, []);

  // ── Shared stages 2-4 runner ──────────────────────────────────────────────
  // Pass existing results to skip completed stages (used by resume).
  const runDownstream = useCallback(async (
    ingestResult: IngestResult,
    sourceText: string,
    existingLogic: LogicTransformResult | null,
    existingUi: UiManifestResult | null,
  ) => {
    try {
      let logicData = existingLogic;
      let uiData = existingUi;

      // ── Stage 2: DeepSeek Engineer → execution logic graph ────────────
      if (!logicData) {
        handleStageChange("reasoning");
        addLog({ level: "info", message: "Blueprint dispatched to Engineer — building execution graph…", model: "deepseek" });

        const logicRes = await fetch("/api/generate-logic", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            objective: `${ingestResult.title}: ${ingestResult.summary}`,
            constraints: [],
            blueprint: { ...ingestResult, createdAtIso: new Date().toISOString() }
          })
        });
        if (!logicRes.ok) {
          const e = await logicRes.json().catch(() => ({ error: `HTTP ${logicRes.status}` })) as { error?: string; detail?: string };
          throw new Error(e.detail ?? e.error ?? `Logic stage: HTTP ${logicRes.status}`);
        }
        logicData = LogicTransformResultSchema.parse(await logicRes.json() as unknown);
        setLogicResult(logicData);
        setActiveNav("architect");
        addLog({
          level: "success",
          message: `Execution graph ready — ${logicData.executionPlan.length} step${logicData.executionPlan.length !== 1 ? "s" : ""} planned`,
          model: "deepseek"
        });
      } else {
        addLog({ level: "info", message: "Execution graph already complete — skipping Stage 2" });
      }

      // ── Stage 3: Claude Designer → UI manifest ────────────────────────
      if (!uiData) {
        handleStageChange("generating");
        addLog({ level: "info", message: "Execution plan dispatched to Designer — synthesising UI manifest…", model: "claude" });

        const uiRes = await fetch("/api/generate-ui", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            objective: `${ingestResult.title}: ${ingestResult.summary}`,
            domain: "Digital Product Academy",
            constraints: [
              "iPad Safari safe — dvh units only",
              "Dark mode only",
              "48px minimum touch targets",
              "No hover-only interactions"
            ]
          })
        });
        if (!uiRes.ok) {
          const e = await uiRes.json().catch(() => ({ error: `HTTP ${uiRes.status}` })) as { error?: string; detail?: string };
          throw new Error(e.detail ?? e.error ?? `UI stage: HTTP ${uiRes.status}`);
        }
        uiData = UiManifestResultSchema.parse(await uiRes.json() as unknown);
        setUiResult(uiData);
        setActiveNav("design");
        addLog({
          level: "success",
          message: `UI manifest complete — ${uiData.components.length} component${uiData.components.length !== 1 ? "s" : ""}  ·  ${uiData.interactions.length} interaction pattern${uiData.interactions.length !== 1 ? "s" : ""}`,
          model: "claude"
        });
      } else {
        addLog({ level: "info", message: "UI manifest already complete — skipping Stage 3" });
      }

      // ── Stage 4: DeepSeek Curator → academy package ───────────────────
      handleStageChange("producing");
      addLog({ level: "info", message: "UI spec dispatched to Curator — packaging full academy…", model: "curator" });

      const produceRes = await fetch("/api/produce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: ingestResult.title,
          summary: ingestResult.summary,
          assets: ingestResult.assets,
          workflow: ingestResult.workflow,
          executionPlan: logicData.executionPlan,
          entities: logicData.entities,
          visualDirection: uiData.visualDirection,
          rawTranscript: sourceText,
          deliveryInstructions,
        })
      });

      if (!produceRes.ok || !produceRes.body) {
        const e = await produceRes.json().catch(() => ({ error: `HTTP ${produceRes.status}` })) as { error?: string; detail?: string };
        throw new Error(e.detail ?? e.error ?? `Produce stage: HTTP ${produceRes.status}`);
      }

      const reader = produceRes.body.getReader();
      const decoder = new TextDecoder();
      let fullBuffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fullBuffer += decoder.decode(value, { stream: true });
      }
      let academyRaw: unknown = null;
      for (const line of fullBuffer.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const parsed = JSON.parse(line.slice(6)) as { error?: string } & Record<string, unknown>;
        if (parsed.error) throw new Error(parsed.error);
        academyRaw = parsed;
        break;
      }

      if (!academyRaw) throw new Error("Produce stage: empty response from server");
      const academyData = AcademyPackageSchema.parse(academyRaw);
      setAcademyResult(academyData);
      localStorage.setItem("nexus_academy_preview", JSON.stringify(academyData));
      setActiveNav("produce");
      addLog({
        level: "success",
        message: `Academy package ready — ${academyData.curriculum.length} module${academyData.curriculum.length !== 1 ? "s" : ""}, ${academyData.pricing.length} pricing tiers`,
        model: "curator"
      });
      handleStageChange("done");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Pipeline error";
      addLog({ level: "error", message: msg });
      handleStageChange("error");
    }
  }, [deliveryInstructions, addLog, handleStageChange]);

  const handleBlueprint = useCallback(async (ingestResult: IngestResult, sourceText = "") => {
    setLogicResult(null);
    setUiResult(null);
    setAcademyResult(null);
    setBlueprint(ingestResult);
    setRawTranscript(sourceText);
    setActiveNav("analyse");

    addLog({
      level: "success",
      message: `Blueprint ready — ${ingestResult.workflow.length} step${ingestResult.workflow.length !== 1 ? "s" : ""}, ${ingestResult.assets.length} asset${ingestResult.assets.length !== 1 ? "s" : ""}`,
    });

    if (ingestResult.assets.length === 0 || ingestResult.workflow.length === 0) {
      addLog({ level: "warn", message: "Blueprint has no assets or workflow — skipping logic + design stages" });
      handleStageChange("done");
      return;
    }

    await runDownstream(ingestResult, sourceText, null, null);
  }, [addLog, handleStageChange, runDownstream]);

  // Resume from the first incomplete stage using whatever is already in state
  const handleResume = useCallback(async () => {
    if (!blueprint) return;
    const resumeStage = !logicResult ? 2 : !uiResult ? 3 : 4;
    addLog({ level: "info", message: `Resuming pipeline from Stage ${resumeStage}…` });
    await runDownstream(blueprint, rawTranscript, logicResult, uiResult);
  }, [blueprint, rawTranscript, logicResult, uiResult, runDownstream, addLog]);

  // Map left-nav items to the PipelineResults tab they drive
  const NAV_TAB: Record<string, "blueprint" | "logic" | "ui" | "academy" | null> = {
    overview:  null,
    analyse:   "blueprint",
    architect: "logic",
    design:    "ui",
    produce:   "academy",
    deploy:    null,
    projects:  null,
    ebook:     null,
    sermon:    null,
  };
  const focusedTab = NAV_TAB[activeNav] ?? undefined;
  const isFocused = activeNav !== "overview";
  const isSermonView = activeNav === "sermon";
  const isBookView = activeNav === "ebook";
  const showActivityPanel = !isSermonView && !isBookView;

  const handleSermonTranscriptSelectionChange = useCallback((sources: EbookTranscriptSource[]) => {
    const parsed = EbookTranscriptSourceSchema.array().safeParse(sources);
    if (!parsed.success || (parsed.success && parsed.data.length > 10)) {
      const message = parsed.success && parsed.data.length > 10
        ? "Select no more than 10 sermon transcripts for the Ebook Pipeline."
        : "The sermon transcripts are not ready to import.";
      setEbookImportNotice({ type: "error", text: message });
      addLog({ level: "error", message });
      return;
    }

    if (parsed.data.length === 0) {
      setEbookTranscriptImports([]);
      setEbookImportNotice(null);
      return;
    }

    const imports = parsed.data.map((source, index) => ({
      ...source,
      requestId: `sermon-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
      slotIndex: index,
    }));
    const validatedImports = EbookTranscriptImportSchema.array().safeParse(imports);
    if (!validatedImports.success) {
      const message = "The sermon transcript selection could not be queued.";
      setEbookImportNotice({ type: "error", text: message });
      addLog({ level: "error", message });
      return;
    }

    setEbookImportNotice(null);
    setEbookTranscriptImports(validatedImports.data);
  }, [addLog]);

  const handleOpenEbookPipeline = useCallback(() => {
    setEbookImportNotice(null);
    setActiveNav("ebook");
  }, []);

  const handleEbookTranscriptImportHandled = useCallback((
    requestId: string,
    result: { ok: boolean; message: string },
  ) => {
    setEbookTranscriptImports((current) => current.filter((item) => item.requestId !== requestId));
    setEbookImportNotice({
      type: result.ok ? "success" : "error",
      text: result.message,
    });
    addLog({
      level: result.ok ? "success" : "error",
      message: result.message,
    });
  }, [addLog]);

  const handleNavSelect = useCallback((id: string) => {
    if (id === "ebook") {
      setActiveNav("ebook");
      return;
    }
    if (id === "translate") {
      router.push("/translate");
      return;
    }
    setActiveNav(id);
  }, [router]);

  return (
    <div className="flex min-h-dvh max-h-dvh overflow-hidden bg-shell-950 bg-grid bg-radial-glow safe-area-frame">
      <NexusNav active={activeNav} onSelect={handleNavSelect} />

      {/* Content column — reserves bottom space for mobile bottom nav (~60px) */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden pb-[max(env(safe-area-inset-bottom),_3.75rem)] lg:pb-0">
        <StatusBar
          stage={stage}
          models={models}
          onAssistant={() => setAssistantOpen((v) => !v)}
          assistantActive={assistantOpen}
        />

        {/*
          Mobile: flex-col + overflow-y-auto so panels stack and scroll.
          Desktop (lg+): grid 5-cols + overflow-hidden so panels fill height.
        */}
        <main className={isSermonView ? "flex min-h-0 flex-1 overflow-hidden" : isBookView ? "flex flex-1 flex-col gap-3 overflow-y-auto overscroll-contain p-3 pb-3 lg:min-h-0 lg:overflow-hidden lg:pb-3" : "flex flex-1 flex-col gap-3 overflow-y-auto overscroll-contain p-3 pb-24 lg:grid lg:min-h-0 lg:overflow-hidden lg:pb-3 lg:grid-cols-5"}>

          {/* ── Focused agent views (non-overview nav) ── */}
          {isFocused ? (
            <>
              {/* Terminal — hidden for sermon mode to maximize writing/presentation space */}
              {showActivityPanel && (
                <div className="hidden lg:block lg:min-h-0 lg:col-span-1">
                  <TerminalLog
                    entries={logs}
                    isStreaming={stage === "ingesting" || stage === "reasoning"}
                  />
                </div>
              )}

              {/* Primary panel — full width on mobile, sermon uses full desktop width */}
              <div
                key={activeNav}
                className={isSermonView ? "flex h-full min-w-0 flex-1 flex-col" : isBookView ? "flex min-h-[65dvh] flex-col animate-fade-up lg:flex-1 lg:min-h-0" : `min-h-[65dvh] animate-fade-up lg:min-h-0 ${showActivityPanel ? "lg:col-span-4" : "lg:col-span-5"}`}
              >
                {activeNav === "projects" ? (
                  <ProjectsPanel
                    projects={projects}
                    folders={folders}
                    suggestedName={blueprint?.title ?? ""}
                    canSave={!!blueprint}
                    onSave={handleSaveProject}
                    onLoad={handleLoadProject}
                    onExport={handleExportProject}
                    onDelete={handleDeleteProject}
                    onImport={handleImportProject}
                    onMoveProject={handleMoveProject}
                    onCreateFolder={handleCreateFolder}
                    onRenameFolder={handleRenameFolder}
                    onDeleteFolder={handleDeleteFolder}
                    folderSyncError={folderSyncError}
                    onPublish={handlePublishProject}
                    onUnpublish={handleUnpublishProject}
                    onUpdateImages={handleUpdateImages}
                  />
                ) : activeNav === "ebook" ? (
                  <div className="flex min-h-0 flex-1 flex-col overflow-y-auto rounded-2xl border border-cyan-500/20 glass">
                    {ebookImportNotice && (
                      <div
                        role={ebookImportNotice.type === "error" ? "alert" : "status"}
                        aria-live="polite"
                        className={`mx-3 mt-3 rounded-xl border px-4 py-3 text-sm ${
                          ebookImportNotice.type === "error"
                            ? "border-red-500/40 bg-red-500/10 text-red-200"
                            : "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                        }`}
                      >
                        {ebookImportNotice.text}
                      </div>
                    )}
                    <EbookPipeline
                      key={ebookPipelineKey}
                      ebookManifest={ebookManifest}
                      transcriptImport={ebookTranscriptImports[0] ?? null}
                      onManifestReady={handleEbookManifestReady}
                      onPipelineSnapshotChange={setEbookSnapshot}
                      onTranscriptImportHandled={handleEbookTranscriptImportHandled}
                      onSaveProject={handleSaveProject}
                    />
                  </div>
                ) : activeNav === "sermon" ? (
                  <SermonAssistantPanel
                    onSermonTranscriptSelectionChange={handleSermonTranscriptSelectionChange}
                    onOpenEbookPipeline={handleOpenEbookPipeline}
                    pendingEbookTranscriptCount={ebookTranscriptImports.length}
                  />
                ) : activeNav === "deploy" ? (
                  <div className="flex h-full flex-col gap-4 overflow-y-auto rounded-2xl border border-cyan-500/20 glass p-5">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-cyan-500">Deploy</p>
                    <h2 className="text-lg font-bold text-white">
                      {blueprint?.title ?? "No project yet"}
                    </h2>
                    {blueprint ? (
                      <div className="flex flex-col gap-3">
                        <a
                          href="/preview"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex min-h-12 items-center justify-center gap-2 rounded-xl bg-cyan-500 px-5 text-sm font-semibold text-slate-950 shadow-glow transition hover:bg-cyan-400"
                        >
                          Launch Landing Page Preview
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" strokeLinecap="round" strokeLinejoin="round" /><path d="M15 3h6v6" strokeLinecap="round" strokeLinejoin="round" /><path d="M10 14 21 3" strokeLinecap="round" strokeLinejoin="round" /></svg>
                        </a>
                        <a
                          href="/preview/learn"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex min-h-12 items-center justify-center gap-2 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-5 text-sm font-semibold text-cyan-300 transition hover:bg-cyan-500/20 hover:border-cyan-400/50"
                        >
                          Open Course Player
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" strokeLinecap="round" strokeLinejoin="round" /><path d="M15 3h6v6" strokeLinecap="round" strokeLinejoin="round" /><path d="M10 14 21 3" strokeLinecap="round" strokeLinejoin="round" /></svg>
                        </a>
                        <div className="rounded-xl border border-slate-700/60 bg-slate-900/60 p-4 text-sm">
                          <p className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-slate-400">Pipeline Status</p>
                          <p className={stage === "done" ? "text-emerald-400" : stage === "error" ? "text-red-400" : "text-slate-400"}>
                            {stage === "done" ? "Build complete — ready to deploy" : stage === "error" ? "Pipeline error" : stage === "idle" ? "Standing by" : "Pipeline running…"}
                          </p>
                          {stage === "error" && blueprint && (
                            <button
                              onClick={() => { void handleResume(); }}
                              className="mt-3 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg bg-amber-500/20 border border-amber-500/40 px-4 text-sm font-semibold text-amber-300 transition hover:bg-amber-500/30 active:scale-95"
                            >
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4 flex-shrink-0">
                                <path d="M12 5v14M5 12l7-7 7 7" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                              Continue from {!logicResult ? "Stage 2 — Logic" : !uiResult ? "Stage 3 — Design" : "Stage 4 — Produce"}
                            </button>
                          )}
                        </div>
                      </div>
                    ) : (
                      <p className="text-sm text-slate-400">Run the pipeline first to generate a deployable academy.</p>
                    )}
                  </div>
                ) : blueprint ? (
                  <PipelineResults
                    blueprint={blueprint}
                    logic={logicResult}
                    ui={uiResult}
                    academy={academyResult}
                    externalTab={focusedTab}
                  />
                ) : (
                  <div className="flex h-full min-h-[300px] items-center justify-center rounded-2xl border border-cyan-500/15 glass">
                    <p className="text-sm text-slate-400">Run the pipeline to see {activeNav} results</p>
                  </div>
                )}
              </div>
            </>
          ) : (
            /* ── Overview (default) layout ── */
            <>
              {/* Terminal log — full width mobile, 3/5 desktop */}
              <div className="min-h-[220px] lg:min-h-0 lg:col-span-2">
                <TerminalLog
                  entries={logs}
                  isStreaming={stage === "ingesting" || stage === "reasoning"}
                />
              </div>

              {/* Right column — full width mobile (stacked), 2/5 desktop (grid-rows-2) */}
              <div className="flex flex-col gap-3 lg:col-span-3 lg:grid lg:min-h-0 lg:grid-rows-2">
                {blueprint !== null ? (
                  <>
                    <PipelineResults
                      blueprint={blueprint}
                      logic={logicResult}
                      ui={uiResult}
                      academy={academyResult}
                    />
                    {stage === "error" && (
                      <button
                        onClick={() => { void handleResume(); }}
                        className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-2xl bg-amber-500/20 border border-amber-500/40 px-4 text-sm font-semibold text-amber-300 transition hover:bg-amber-500/30 active:scale-95"
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4 flex-shrink-0">
                          <path d="M12 5v14M5 12l7-7 7 7" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        Continue from {!logicResult ? "Stage 2 — Logic" : !uiResult ? "Stage 3 — Design" : "Stage 4 — Produce"}
                      </button>
                    )}
                  </>
                ) : (
                  <ProjectCard
                    title="Mission Control"
                    status="Healthy"
                    detail="Upload raw footage, workshop recordings, or podcast archives. One command builds a complete academy with structured outputs."
                    metrics={[
                      { label: "Pipeline", value: "Academy" },
                      { label: "Book", value: "Ready" },
                      { label: "Sermon", value: "Ready" },
                      { label: "Viewport", value: "Mobile-first" },
                    ]}
                  />
                )}

                <MediaUpload
                  onLog={addLog}
                  onBlueprint={handleBlueprint}
                  onStageChange={handleStageChange}
                />
              </div>
            </>
          )}
        </main>

        {!isSermonView && !isBookView && (
          <PromptBar
            stage={stage}
            onLog={addLog}
            onBlueprint={handleBlueprint}
            onStageChange={handleStageChange}
            onDeliveryChange={setDeliveryInstructions}
          />
        )}
      </div>

      {/* Director AI drawer — toggled from StatusBar */}
      <AssistantPanel
        isOpen={assistantOpen}
        onClose={() => setAssistantOpen(false)}
        academy={academyResult}
        onUpdate={handleAssistantUpdate}
        siteConfig={siteConfig}
        onSiteUpdate={handleSiteUpdate}
        ebookManifest={ebookManifest}
        onEbookUpdate={(updated, summary) => {
          setEbookManifest(updated);
          if (summary) addLog({ level: "success", message: `Director: ${summary}`, model: "curator" });
        }}
        ebookPipelineSnapshot={ebookSnapshot}
        loadedHistory={chatHistory}
        loadKey={panelLoadKey}
        onChatChange={setChatHistory}
      />
    </div>
  );
}
