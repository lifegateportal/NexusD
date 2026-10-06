"use client";

import { useRef, useState, useEffect } from "react";
import { SiteConfigSchema } from "@/lib/schemas/site-config";
import type { ProjectSnapshot } from "@/lib/project-store";
import type { EbookProject } from "@/lib/ebook-project-store";
import { ProjectFolderTree } from "@/app/components/ProjectFolderTree";
import {
  flattenProjectFolders,
  UNFILED_FOLDER_ID,
  type ProjectFolder,
} from "@/lib/project-organization-store";

type ProjectsPanelProps = {
  projects: ProjectSnapshot[];
  folders: ProjectFolder[];
  suggestedName: string;
  canSave: boolean;
  onSave: (name: string, folderId?: string) => void;
  onLoad: (id: string) => void;
  onExport?: (id: string) => Promise<ProjectSnapshot | null>;
  onDelete: (id: string) => void;
  onImport: (snapshot: ProjectSnapshot) => void;
  onMoveProject: (id: string, folderId: string) => void | Promise<void>;
  onCreateFolder: (name: string, parentId: string | null) => void | Promise<void>;
  onRenameFolder: (id: string, name: string) => void | Promise<void>;
  onDeleteFolder: (id: string) => void | Promise<void>;
  folderSyncError?: string | null;
  /** Publish an ebook project to the Library — returns the slug on success */
  onPublish?: (project: ProjectSnapshot) => Promise<string | null>;
  /** Unpublish (remove from library) a published project */
  onUnpublish?: (project: ProjectSnapshot) => Promise<boolean>;
  /** Called after a cover or author image is uploaded, to persist the new URL */
  onUpdateImages?: (id: string, coverImageUrl?: string, authorImageUrl?: string) => Promise<void>;
};

function exportProject(p: ProjectSnapshot) {
  const json = JSON.stringify(p, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `${p.name.replace(/[^a-z0-9]/gi, "_").toLowerCase()}_nexus.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function ProjectsPanel({
  projects: allProjects,
  folders,
  suggestedName,
  canSave,
  onSave,
  onLoad,
  onExport,
  onDelete,
  onImport,
  onMoveProject,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  folderSyncError,
  onPublish,
  onUnpublish,
  onUpdateImages,
}: ProjectsPanelProps) {
  const PROJECT_PAGE_SIZE = 20;
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const folderCounts = allProjects.reduce<Record<string, number>>((counts, project) => {
    const folderId = project.folderId ?? UNFILED_FOLDER_ID;
    counts[folderId] = (counts[folderId] ?? 0) + 1;
    return counts;
  }, {});
  const projects = selectedFolderId === null
    ? allProjects
    : allProjects.filter((project) => (project.folderId ?? UNFILED_FOLDER_ID) === selectedFolderId);
  const [visibleProjectCount, setVisibleProjectCount] = useState(PROJECT_PAGE_SIZE);
  const folderOptions = flattenProjectFolders(folders);
  const [name, setName] = useState(suggestedName);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmUnpublish, setConfirmUnpublish] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [publishingId, setPublishingId] = useState<string | null>(null);
  const [unpublishingId, setUnpublishingId] = useState<string | null>(null);
  const [imageUploading, setImageUploading] = useState<{ id: string; type: "cover" | "author" } | null>(null);
  const imageTargetRef = useRef<{ id: string; type: "cover" | "author" } | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setVisibleProjectCount(PROJECT_PAGE_SIZE);
  }, [selectedFolderId, projects.length]);

  useEffect(() => {
    const panel = panelRef.current;
    const sentinel = loadMoreRef.current;
    if (!panel || !sentinel || visibleProjectCount >= projects.length || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisibleProjectCount((count) => Math.min(count + PROJECT_PAGE_SIZE, projects.length));
        }
      },
      { root: panel, rootMargin: "0px 0px 480px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [projects.length, visibleProjectCount]);

  async function handleImageFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    const target = imageTargetRef.current;
    if (!file || !target || !onUpdateImages) return;
    setImageUploading(target);
    try {
      const presignRes = await fetch("/api/r2-presign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, contentType: file.type, prefix: "images" }),
      });
      if (!presignRes.ok) throw new Error("Could not get upload URL.");
      const { presignedUrl, publicUrl } = await presignRes.json() as { presignedUrl: string; publicUrl: string | null };
      if (!presignedUrl || !publicUrl) throw new Error("Storage not configured.");
      const uploadRes = await fetch(presignedUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!uploadRes.ok) throw new Error("Upload failed.");
      await onUpdateImages(
        target.id,
        target.type === "cover"  ? publicUrl : undefined,
        target.type === "author" ? publicUrl : undefined,
      );
    } catch { /* silently ignore — user can retry */ }
    finally {
      setImageUploading(null);
      imageTargetRef.current = null;
    }
  }

  function handleFileImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target?.result as string) as Record<string, unknown>;
        const freshId = `proj-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const defaultSiteConfig = SiteConfigSchema.parse({});
        let snapshot: ProjectSnapshot;

        if ("jobState" in parsed && parsed.jobState && typeof parsed.jobState === "object") {
          // EbookProject format — exported from the /ebook Projects tab
          const ep = parsed as unknown as EbookProject;
          snapshot = {
            id: freshId,
            name: (ep.name || ep.bookTitle || "Imported Ebook") as string,
            createdAt: (ep.createdAt ?? new Date().toISOString()) as string,
            updatedAt: new Date().toISOString(),
            folderId: ep.folderId,
            academy: null,
            siteConfig: defaultSiteConfig,
            deliveryInstructions: "",
            chatHistory: [],
            blueprint: null,
            logicResult: null,
            uiResult: null,
            ebookManifest: null,
            ebookJobState: ep.jobState,
          };
        } else if (
          // Raw EbookJobState — e.g. pasted from localStorage
          "status" in parsed && "transcripts" in parsed
        ) {
          const rawJob = parsed as unknown as EbookProject["jobState"];
          snapshot = {
            id: freshId,
            name: "Imported Ebook",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            folderId: undefined,
            academy: null,
            siteConfig: defaultSiteConfig,
            deliveryInstructions: "",
            chatHistory: [],
            blueprint: null,
            logicResult: null,
            uiResult: null,
            ebookManifest: null,
            ebookJobState: rawJob,
          };
        } else if (parsed.id && parsed.name) {
          // Standard ProjectSnapshot format
          snapshot = {
            ...(parsed as unknown as ProjectSnapshot),
            id: freshId,
            updatedAt: new Date().toISOString(),
          };
        } else {
          throw new Error("Unrecognised file format.");
        }

        onImport(snapshot);
        setImportError(null);
      } catch (err) {
        const detail = err instanceof Error ? ` (${err.message})` : "";
        setImportError(`Could not read file — make sure it's a valid Nexus project or ebook export.${detail}`);
      }
    };
    reader.readAsText(file);
    // reset so the same file can be re-selected if needed
    e.target.value = "";
  }

  return (
    <div ref={panelRef} className="flex h-full flex-col gap-4 overflow-y-auto rounded-2xl border border-slate-700/60 glass p-5">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Projects</p>
          <h2 className="text-lg font-bold text-slate-100">Saved Workspaces</h2>
        </div>
        {/* Import button */}
        <button
          onClick={() => fileInputRef.current?.click()}
          className="flex min-h-10 items-center gap-1.5 rounded-xl border border-slate-600 px-3 text-xs font-semibold text-slate-400 transition hover:border-cyan-500/50 hover:text-cyan-300"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-4 w-4">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" strokeLinecap="round" strokeLinejoin="round" />
            <polyline points="17 8 12 3 7 8" strokeLinecap="round" strokeLinejoin="round" />
            <line x1="12" y1="3" x2="12" y2="15" strokeLinecap="round" />
          </svg>
          Import
        </button>
        <input ref={fileInputRef}  type="file" accept=".json,application/json" className="hidden" onChange={handleFileImport} />
        <input ref={imageInputRef} type="file" accept="image/*" className="hidden" onChange={handleImageFileChange} />
      </div>

      {importError && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">{importError}</p>
      )}

      {/* Save current project */}
      {canSave && (
        <div className="flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Project name…"
            className="min-h-12 flex-1 rounded-xl border border-slate-600 bg-slate-800/60 px-4 text-base text-slate-100 placeholder-slate-500 focus:border-cyan-500 focus:outline-none"
          />
          <button
            onClick={() => { if (name.trim()) onSave(name.trim(), selectedFolderId ?? UNFILED_FOLDER_ID); }}
            disabled={!name.trim()}
            className="min-h-12 rounded-xl bg-accent-500 px-5 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-40"
          >
            Save
          </button>
        </div>
      )}

      <div className="grid min-h-0 gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
        <ProjectFolderTree
          folders={folders}
          selectedFolderId={selectedFolderId}
          projectCounts={folderCounts}
          totalProjectCount={allProjects.length}
          onSelect={setSelectedFolderId}
          onCreate={onCreateFolder}
          onRename={onRenameFolder}
          onDelete={onDeleteFolder}
          syncError={folderSyncError}
        />
        <div className="min-w-0">
          {projects.length === 0 ? (
            <div className="rounded-xl border border-slate-700/40 bg-slate-800/20 p-6 text-center">
              <p className="text-sm text-slate-400">
                {allProjects.length === 0 ? "No saved projects yet." : "No projects in this folder."}
              </p>
              <p className="mt-1 text-xs text-slate-600">
                {allProjects.length === 0
                  ? "Run the pipeline, then save your work here to come back to it later."
                  : "Move a project here from its folder menu or choose another folder."}
              </p>
            </div>
          ) : (
        <div className="flex flex-col gap-2">
          {projects.slice(0, visibleProjectCount).map((p) => (
            <div key={p.id} className="rounded-xl border border-slate-700/50 bg-slate-800/40 p-4">
              <div className="mb-3 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-semibold text-slate-100">{p.name}</p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {(p.ebookChapterCount !== undefined || p.ebookJobState || p.ebookManifest)
                      ? `${p.ebookChapterCount ?? p.ebookManifest?.chapters.length ?? p.ebookJobState?.chapters.length ?? 0} chapter${(p.ebookChapterCount ?? p.ebookManifest?.chapters.length ?? p.ebookJobState?.chapters.length ?? 0) !== 1 ? "s" : ""} · ${(p.ebookTotalWordCount ?? p.ebookManifest?.totalWordCount ?? 0).toLocaleString()} words`
                      : p.ebookStatus
                        ? `Ebook in progress · ${p.ebookStatus}`
                        : p.hasAcademy
                          ? "Academy project"
                          : null}
                    {" · "}
                    <span>
                      Created {new Date(p.createdAt).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                      })}
                    </span>
                    {" · "}
                    <span>
                      Updated {new Date(p.updatedAt).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </span>
                  </p>
                </div>

                {confirmDelete === p.id ? (
                  <div className="flex shrink-0 gap-1">
                    <button
                      onClick={() => { onDelete(p.id); setConfirmDelete(null); }}
                      className="min-h-8 rounded-lg bg-red-500/20 px-3 text-xs font-semibold text-red-400 transition hover:bg-red-500/30"
                    >
                      Delete
                    </button>
                    <button
                      onClick={() => setConfirmDelete(null)}
                      className="min-h-8 rounded-lg bg-slate-700/50 px-3 text-xs text-slate-400 transition hover:bg-slate-700"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmDelete(p.id)}
                    aria-label="Delete project"
                    className="shrink-0 min-h-8 min-w-8 flex items-center justify-center rounded-lg bg-slate-700/30 text-slate-500 transition hover:text-red-400"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-4 w-4">
                      <polyline points="3 6 5 6 21 6" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M10 11v6M14 11v6" strokeLinecap="round" />
                      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" strokeLinecap="round" />
                    </svg>
                  </button>
                )}
              </div>

              <div className="flex gap-2">
                <button
                  onClick={() => onLoad(p.id)}
                  className="flex min-h-10 flex-1 items-center justify-center gap-2 rounded-lg border border-slate-600 text-sm font-semibold text-slate-300 transition hover:border-cyan-500/50 hover:text-cyan-400"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-4 w-4">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" strokeLinecap="round" strokeLinejoin="round" />
                    <polyline points="7 10 12 15 17 10" strokeLinecap="round" strokeLinejoin="round" />
                    <line x1="12" y1="15" x2="12" y2="3" strokeLinecap="round" />
                  </svg>
                  Load
                </button>
                <button
                  onClick={async () => {
                    const fullProject = onExport ? await onExport(p.id) : p;
                    if (fullProject) exportProject(fullProject);
                  }}
                  title="Export project as JSON file"
                  className="flex min-h-10 min-w-[2.75rem] items-center justify-center rounded-lg border border-slate-600 text-slate-400 transition hover:border-cyan-500/50 hover:text-cyan-300"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-4 w-4">
                    <path d="M12 3v12" strokeLinecap="round" />
                    <polyline points="17 12 12 17 7 12" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M3 17v2a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2" strokeLinecap="round" />
                  </svg>
                </button>
              </div>

              <label className="mt-2 flex min-h-12 items-center gap-2 rounded-lg border border-slate-700/50 bg-slate-900/30 px-3 text-xs text-slate-500">
                <span className="shrink-0">Folder</span>
                <select
                  value={p.folderId ?? UNFILED_FOLDER_ID}
                  onChange={(event) => void onMoveProject(p.id, event.target.value)}
                  aria-label={`Move ${p.name} to folder`}
                  className="min-h-12 min-w-0 flex-1 bg-transparent text-base text-slate-300 focus:outline-none"
                >
                  {folderOptions.map((folder) => (
                    <option key={folder.id} value={folder.id} className="bg-slate-900">
                      {folder.name}
                    </option>
                  ))}
                </select>
              </label>

              {/* Book images — only for ebook projects */}
              {onUpdateImages && (p.hasEbookContent || p.ebookJobState || p.ebookManifest) && (
                <div className="mt-2 flex items-center gap-3 rounded-xl border border-slate-700/40 bg-slate-800/30 p-3">
                  {/* Cover image slot */}
                  <button
                    onClick={() => {
                      imageTargetRef.current = { id: p.id, type: "cover" };
                      imageInputRef.current?.click();
                    }}
                    title="Upload book cover"
                    className="relative flex h-16 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-slate-600 bg-slate-800 transition hover:border-cyan-500/60"
                  >
                    {p.coverImageUrl ? (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img src={p.coverImageUrl} alt="Cover" className="h-full w-full object-cover" />
                    ) : (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-5 w-5 text-slate-500">
                        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" strokeLinecap="round" strokeLinejoin="round" />
                        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                    {imageUploading?.id === p.id && imageUploading.type === "cover" && (
                      <div className="absolute inset-0 flex items-center justify-center bg-slate-900/70">
                        <svg className="h-4 w-4 animate-spin text-cyan-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" strokeLinecap="round" />
                        </svg>
                      </div>
                    )}
                  </button>

                  {/* Author photo slot */}
                  <button
                    onClick={() => {
                      imageTargetRef.current = { id: p.id, type: "author" };
                      imageInputRef.current?.click();
                    }}
                    title="Upload author photo"
                    className="relative flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full border border-slate-600 bg-slate-800 transition hover:border-cyan-500/60"
                  >
                    {p.authorImageUrl ? (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img src={p.authorImageUrl} alt="Author" className="h-full w-full object-cover" />
                    ) : (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-5 w-5 text-slate-500">
                        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" strokeLinecap="round" strokeLinejoin="round" />
                        <circle cx="12" cy="7" r="4" strokeLinecap="round" />
                      </svg>
                    )}
                    {imageUploading?.id === p.id && imageUploading.type === "author" && (
                      <div className="absolute inset-0 flex items-center justify-center rounded-full bg-slate-900/70">
                        <svg className="h-4 w-4 animate-spin text-cyan-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" strokeLinecap="round" />
                        </svg>
                      </div>
                    )}
                  </button>

                  <div className="min-w-0">
                    <p className="text-xs font-medium text-slate-400">
                      {p.coverImageUrl ? "Cover uploaded ✓" : "Tap to add cover"}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-600">
                      {p.authorImageUrl ? "Author photo set ✓" : "Tap ○ for author photo"}
                    </p>
                  </div>
                </div>
              )}

              {/* Publish / Published row — shown when project has ebook content */}
              {onPublish && (p.hasEbookContent || p.ebookJobState || p.ebookManifest) && (
                <div className="mt-2 space-y-1.5">
                  {p.publishedSlug ? (
                    <>
                      <a
                        href={`/library/${p.publishedSlug}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex min-h-10 w-full items-center justify-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-sm font-semibold text-emerald-400 transition hover:bg-emerald-500/15"
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-4 w-4">
                          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" strokeLinecap="round" strokeLinejoin="round" />
                          <polyline points="15 3 21 3 21 9" strokeLinecap="round" strokeLinejoin="round" />
                          <line x1="10" y1="14" x2="21" y2="3" strokeLinecap="round" />
                        </svg>
                        View in Library
                      </a>
                      <button
                        onClick={async () => {
                          setPublishingId(p.id);
                          try { await onPublish(p); }
                          finally { setPublishingId(null); }
                        }}
                        disabled={publishingId === p.id}
                        className="flex min-h-10 w-full items-center justify-center gap-2 rounded-lg border border-slate-700/60 bg-slate-800/40 text-sm font-medium text-slate-400 transition hover:border-amber-500/40 hover:bg-amber-500/10 hover:text-amber-400 disabled:opacity-50"
                      >
                        {publishingId === p.id ? (
                          <>
                            <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" strokeLinecap="round" />
                            </svg>
                            Republishing…
                          </>
                        ) : (
                          <>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-4 w-4">
                              <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 0 0 4.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 0 1-15.357-2m15.357 2H15" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                            Republish
                          </>
                        )}
                      </button>

                      {/* Unpublish */}
                      {onUnpublish && (
                        confirmUnpublish === p.id ? (
                          <div className="flex gap-2">
                            <button
                              onClick={async () => {
                                setUnpublishingId(p.id);
                                setConfirmUnpublish(null);
                                try { await onUnpublish(p); }
                                finally { setUnpublishingId(null); }
                              }}
                              disabled={unpublishingId === p.id}
                              className="flex flex-1 min-h-10 items-center justify-center rounded-lg bg-red-500/20 text-sm font-semibold text-red-400 transition hover:bg-red-500/30 disabled:opacity-50"
                            >
                              {unpublishingId === p.id ? "Unpublishing…" : "Yes, unpublish"}
                            </button>
                            <button
                              onClick={() => setConfirmUnpublish(null)}
                              className="flex flex-1 min-h-10 items-center justify-center rounded-lg bg-slate-700/50 text-sm text-slate-400 transition hover:bg-slate-700"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setConfirmUnpublish(p.id)}
                            disabled={unpublishingId === p.id}
                            className="flex min-h-10 w-full items-center justify-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 text-sm font-semibold text-red-400 transition hover:bg-red-500/20 disabled:opacity-50"
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-4 w-4 shrink-0">
                              <path d="M18.364 18.364A9 9 0 0 0 5.636 5.636m12.728 12.728A9 9 0 0 1 5.636 5.636m12.728 12.728L5.636 5.636" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                            Unpublish
                          </button>
                        )
                      )}
                    </>
                  ) : (
                    <button
                      onClick={async () => {
                        setPublishingId(p.id);
                        try { await onPublish(p); }
                        finally { setPublishingId(null); }
                      }}
                      disabled={publishingId === p.id}
                      className="flex min-h-10 w-full items-center justify-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 text-sm font-semibold text-amber-400 transition hover:bg-amber-500/15 disabled:opacity-50"
                    >
                      {publishingId === p.id ? (
                        <>
                          <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" strokeLinecap="round" />
                          </svg>
                          Publishing…
                        </>
                      ) : (
                        <>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-4 w-4">
                            <path d="M12 2L2 7l10 5 10-5-10-5z" strokeLinecap="round" strokeLinejoin="round" />
                            <path d="M2 17l10 5 10-5" strokeLinecap="round" strokeLinejoin="round" />
                            <path d="M2 12l10 5 10-5" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                          Publish to Library
                        </>
                      )}
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
          )}
          {visibleProjectCount < projects.length && <div ref={loadMoreRef} className="h-1" aria-hidden="true" />}
        </div>
      </div>
    </div>
  );
}
