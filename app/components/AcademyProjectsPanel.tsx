"use client";

import { useEffect, useRef, useState } from "react";
import { AcademyProjectSchema } from "@/lib/schemas/academy-project";
import type { AcademyProject, AcademyProjectSummary } from "@/lib/academy-project-store";
import { ProjectFolderTree } from "@/app/components/ProjectFolderTree";
import {
  flattenProjectFolders,
  UNFILED_FOLDER_ID,
  type ProjectFolder,
} from "@/lib/project-organization-store";

type Props = {
  projects: AcademyProjectSummary[];
  folders: ProjectFolder[];
  suggestedName: string;
  canSave: boolean;
  onSave: (name: string, folderId?: string) => void | Promise<void | boolean>;
  onLoad: (id: string) => void | Promise<void>;
  onExport?: (id: string) => Promise<AcademyProject | null>;
  onDelete: (id: string) => void | Promise<void>;
  onImport: (project: AcademyProject) => void | Promise<void>;
  onMoveProject: (id: string, folderId: string) => void | Promise<void>;
  onCreateFolder: (name: string, parentId: string | null) => void | Promise<void>;
  onRenameFolder: (id: string, name: string) => void | Promise<void>;
  onDeleteFolder: (id: string) => void | Promise<void>;
  folderSyncError?: string | null;
  onPublishAcademy?: (project: AcademyProjectSummary) => Promise<string | null>;
  onUnpublishAcademy?: (project: AcademyProjectSummary) => Promise<boolean>;
};

function exportProject(project: AcademyProject) {
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${project.name.replace(/[^a-z0-9]/gi, "_").toLowerCase()}_academy.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function AcademyProjectsPanel({
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
  onPublishAcademy,
  onUnpublishAcademy,
}: Props) {
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [visibleProjectCount, setVisibleProjectCount] = useState(20);
  const [name, setName] = useState(suggestedName);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmUnpublish, setConfirmUnpublish] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [publishingId, setPublishingId] = useState<string | null>(null);
  const [unpublishingId, setUnpublishingId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  const projects = selectedFolderId === null
    ? allProjects
    : allProjects.filter((project) => (project.folderId ?? UNFILED_FOLDER_ID) === selectedFolderId);
  const folderOptions = flattenProjectFolders(folders);
  const folderCounts = allProjects.reduce<Record<string, number>>((counts, project) => {
    const folderId = project.folderId ?? UNFILED_FOLDER_ID;
    counts[folderId] = (counts[folderId] ?? 0) + 1;
    return counts;
  }, {});

  useEffect(() => {
    setName(suggestedName);
  }, [suggestedName]);

  useEffect(() => {
    setVisibleProjectCount(20);
  }, [selectedFolderId, projects.length]);

  useEffect(() => {
    const panel = panelRef.current;
    const sentinel = loadMoreRef.current;
    if (!panel || !sentinel || visibleProjectCount >= projects.length || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisibleProjectCount((count) => Math.min(count + 20, projects.length));
        }
      },
      { root: panel, rootMargin: "0px 0px 480px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [projects.length, visibleProjectCount]);

  function handleImport(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as Record<string, unknown>;
        if (!parsed.academy) throw new Error("The file does not contain an Academy course.");
        const project = AcademyProjectSchema.parse({
          name: parsed.name,
          createdAt: parsed.createdAt,
          folderId: parsed.folderId,
          academy: parsed.academy,
          siteConfig: parsed.siteConfig ?? {},
          deliveryInstructions: parsed.deliveryInstructions ?? "",
          chatHistory: parsed.chatHistory ?? [],
          blueprint: parsed.blueprint ?? null,
          logicResult: parsed.logicResult ?? null,
          uiResult: parsed.uiResult ?? null,
          academyPublishedSlug: parsed.academyPublishedSlug,
          id: `academy-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          updatedAt: new Date().toISOString(),
        });
        void onImport(project);
        setImportError(null);
      } catch (error) {
        setImportError(error instanceof Error ? error.message : "Could not import Academy project.");
      }
    };
    reader.readAsText(file);
  }

  return (
    <div ref={panelRef} className="flex h-auto min-h-0 flex-col gap-4 overflow-visible rounded-2xl border border-slate-700/60 glass p-5 lg:h-full lg:overflow-y-auto">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-cyan-500">Academy</p>
          <h2 className="text-lg font-bold text-slate-100">Saved Academy Courses</h2>
          <p className="mt-1 text-xs text-slate-500">Separate from Ebook projects · publish only what you choose</p>
        </div>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="flex min-h-12 items-center gap-1.5 rounded-xl border border-slate-600 px-3 text-xs font-semibold text-slate-400 transition hover:border-cyan-500/50 hover:text-cyan-300"
        >
          Import
        </button>
        <input ref={fileInputRef} type="file" accept=".json,application/json" className="hidden" onChange={handleImport} />
      </div>

      {importError && (
        <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {importError}
        </p>
      )}
      {folderSyncError && (
        <p role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          {folderSyncError}
        </p>
      )}

      {canSave && (
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Academy project name…"
            className="min-h-12 min-w-0 flex-1 rounded-xl border border-slate-600 bg-slate-800/60 px-4 text-base text-slate-100 placeholder-slate-500 focus:border-cyan-500 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => {
              if (name.trim()) void onSave(name.trim(), selectedFolderId ?? UNFILED_FOLDER_ID);
            }}
            disabled={!name.trim()}
            className="min-h-12 rounded-xl bg-cyan-600 px-5 text-sm font-semibold text-white transition hover:bg-cyan-500 disabled:opacity-40"
          >
            Save Academy Project
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
                {allProjects.length === 0 ? "No saved Academy courses yet." : "No Academy courses in this folder."}
              </p>
              <p className="mt-1 text-xs text-slate-600">
                Run the Academy pipeline, save the course, then choose which courses to publish.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {projects.slice(0, visibleProjectCount).map((project) => (
                <div key={project.id} className="rounded-xl border border-slate-700/50 bg-slate-800/40 p-4">
                  <div className="mb-3 flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-slate-100">{project.name}</p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        Academy course · Updated {new Date(project.updatedAt).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </p>
                    </div>
                    {confirmDelete === project.id ? (
                      <div className="flex shrink-0 gap-1">
                        <button
                          type="button"
                          onClick={() => { void onDelete(project.id); setConfirmDelete(null); }}
                          className="min-h-12 rounded-lg bg-red-500/20 px-3 text-xs font-semibold text-red-400"
                        >
                          Delete
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDelete(null)}
                          className="min-h-12 rounded-lg bg-slate-700/50 px-3 text-xs text-slate-400"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(project.id)}
                        aria-label={`Delete ${project.name}`}
                        className="flex min-h-12 min-w-12 items-center justify-center rounded-lg bg-slate-700/30 text-slate-500 transition hover:text-red-400"
                      >
                        ×
                      </button>
                    )}
                  </div>

                  <div className="flex flex-col gap-2 sm:flex-row">
                    <button
                      type="button"
                      onClick={() => void onLoad(project.id)}
                      className="flex min-h-12 flex-1 items-center justify-center rounded-lg border border-slate-600 text-sm font-semibold text-slate-300 transition hover:border-cyan-500/50 hover:text-cyan-400"
                    >
                      Load Academy
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        const fullProject = onExport ? await onExport(project.id) : null;
                        if (fullProject) exportProject(fullProject);
                      }}
                      className="flex min-h-12 min-w-12 items-center justify-center rounded-lg border border-slate-600 text-slate-400 transition hover:border-cyan-500/50 hover:text-cyan-300"
                      aria-label={`Export ${project.name}`}
                    >
                      Export
                    </button>
                  </div>

                  <label className="mt-2 flex min-h-12 items-center gap-2 rounded-lg border border-slate-700/50 bg-slate-900/30 px-3 text-xs text-slate-500">
                    <span className="shrink-0">Folder</span>
                    <select
                      value={project.folderId ?? UNFILED_FOLDER_ID}
                      onChange={(event) => void onMoveProject(project.id, event.target.value)}
                      aria-label={`Move ${project.name} to folder`}
                      className="min-h-12 min-w-0 flex-1 bg-transparent text-base text-slate-300 focus:outline-none"
                    >
                      {folderOptions.map((folder) => (
                        <option key={folder.id} value={folder.id} className="bg-slate-900">{folder.name}</option>
                      ))}
                    </select>
                  </label>

                  {onPublishAcademy && (
                    <div className="mt-2 space-y-2">
                      {project.academyPublishedSlug ? (
                        <>
                          {project.academyPublishedVersion
                            && project.academyDraftVersion
                            && project.academyPublishedVersion !== project.academyDraftVersion && (
                            <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-300">
                              Unpublished edits are ready. Republish to update the live course.
                            </p>
                          )}
                          <a
                            href={`/academy/${project.academyPublishedSlug}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex min-h-12 w-full items-center justify-center rounded-lg border border-cyan-500/40 bg-cyan-500/10 text-sm font-semibold text-cyan-400 transition hover:bg-cyan-500/15"
                          >
                            Open Course
                          </a>
                          <a
                            href="/academy"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex min-h-12 w-full items-center justify-center rounded-lg border border-slate-700/60 bg-slate-800/40 text-sm font-semibold text-slate-300"
                          >
                            Browse Academy Catalog
                          </a>
                          <button
                            type="button"
                            onClick={async () => {
                              setPublishingId(project.id);
                              try { await onPublishAcademy(project); } finally { setPublishingId(null); }
                            }}
                            disabled={publishingId === project.id}
                            className="flex min-h-12 w-full items-center justify-center rounded-lg border border-slate-700/60 bg-slate-800/40 text-sm font-medium text-slate-400 disabled:opacity-50"
                          >
                            {publishingId === project.id ? "Republishing…" : "Republish Academy"}
                          </button>
                          {onUnpublishAcademy && (
                            confirmUnpublish === project.id ? (
                              <div className="flex gap-2">
                                <button
                                  type="button"
                                  onClick={async () => {
                                    setUnpublishingId(project.id);
                                    setConfirmUnpublish(null);
                                    try { await onUnpublishAcademy(project); } finally { setUnpublishingId(null); }
                                  }}
                                  disabled={unpublishingId === project.id}
                                  className="min-h-12 flex-1 rounded-lg bg-red-500/20 text-sm font-semibold text-red-400"
                                >
                                  {unpublishingId === project.id ? "Unpublishing…" : "Yes, unpublish"}
                                </button>
                                <button type="button" onClick={() => setConfirmUnpublish(null)} className="min-h-12 flex-1 rounded-lg bg-slate-700/50 text-sm text-slate-400">
                                  Cancel
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setConfirmUnpublish(project.id)}
                                className="flex min-h-12 w-full items-center justify-center rounded-lg border border-red-500/30 bg-red-500/10 text-sm font-semibold text-red-400"
                              >
                                Unpublish Academy
                              </button>
                            )
                          )}
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={async () => {
                            setPublishingId(project.id);
                            try { await onPublishAcademy(project); } finally { setPublishingId(null); }
                          }}
                          disabled={publishingId === project.id}
                          className="flex min-h-12 w-full items-center justify-center rounded-lg border border-cyan-500/40 bg-cyan-500/10 text-sm font-semibold text-cyan-400 disabled:opacity-50"
                        >
                          {publishingId === project.id ? "Publishing…" : "Publish to Academy"}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
              {visibleProjectCount < projects.length && <div ref={loadMoreRef} className="h-1" aria-hidden="true" />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
