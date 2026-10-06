"use client";

import { useRef, useState, useEffect } from "react";
import type { EbookProject } from "@/lib/ebook-project-store";
import type { EbookJobState, EbookManifest } from "@/lib/schemas/ebook";
import { EbookManifestSchema, EbookJobStateSchema } from "@/lib/schemas/ebook";
import type { ProjectSnapshot } from "@/lib/project-store";
import type { PublishedBookEntry } from "@/lib/schemas/published-book";
import { ProjectFolderTree } from "@/app/components/ProjectFolderTree";
import {
  flattenProjectFolders,
  UNFILED_FOLDER_ID,
  type ProjectFolder,
} from "@/lib/project-organization-store";

type EbookProjectsPanelProps = {
  projects: EbookProject[];
  folders: ProjectFolder[];
  suggestedName: string;
  canSave: boolean;
  onSave: (name: string, folderId?: string) => void;
  onLoad: (id: string) => void;
  onDelete: (id: string) => void;
  onImport: (project: EbookProject) => void;
  onMoveProject: (id: string, folderId: string) => void | Promise<void>;
  onCreateFolder: (name: string, parentId: string | null) => void | Promise<void>;
  onRenameFolder: (id: string, name: string) => void | Promise<void>;
  onDeleteFolder: (id: string) => void | Promise<void>;
  /** Called with the parsed job state so the page can build a manifest from it */
  onImportManifestJson?: (job: EbookJobState) => EbookManifest | null;
  /** Called when a manifest/job JSON is successfully parsed from a device file */
  onManifestLoaded?: (manifest: EbookManifest) => void;
  /** Publish a completed project to the Library — returns the slug on success */
  onPublish?: (project: EbookProject) => Promise<string | null>;
  /** Remove a published book from the Library catalog */
  onUnpublish?: (project: EbookProject) => Promise<boolean>;
  /** Called after a cover or author image is uploaded, to persist the new URL */
  onUpdateImages?: (id: string, coverImageUrl?: string, authorImageUrl?: string) => Promise<void>;
};

function exportProject(p: EbookProject) {
  const json = JSON.stringify(p, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `${p.name.replace(/[^a-z0-9]/gi, "_").toLowerCase()}_ebook.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function buildManifest(p: EbookProject): EbookManifest {
  const job = p.jobState;
  return {
    jobId: job.jobId,
    bookTitle: job.architecture?.bookTitle ?? p.bookTitle,
    subtitle: job.architecture?.subtitle ?? "",
    authorName: job.architecture?.authorName ?? "Unknown Author",
    frontMatter: job.frontMatter ?? {
      preface: "",
      introduction: "",
      conclusion: "",
      aboutAuthor: null,
      resourcesList: [],
      scriptureIndex: [],
    },
    chapters: job.chapters,
    totalWordCount: p.totalWordCount,
    allQuotes: job.contentMap?.allQuotes ?? [],
    generatedAt: job.updatedAt,
    selectedTemplate: "devotional",
    printSpec: { trimSize: "6x9", runningHeaders: true, bleed: false, cropMarks: false, editableProof: false, folioStyle: "center", frontMatterNumbering: "arabic", sectionOrnament: "rule", bodyTextAlign: "template", bodyFontFamily: "template", fontSizeScale: 1.0 },
    coverImageUrl: p.coverImageUrl ?? null,
    authorImageUrl: p.authorImageUrl ?? null,
  };
}

export function EbookProjectsPanel({
  projects,
  folders,
  suggestedName,
  canSave,
  onSave,
  onLoad,
  onDelete,
  onImport,
  onMoveProject,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onImportManifestJson,
  onManifestLoaded,
  onPublish,
  onUnpublish,
  onUpdateImages,
}: EbookProjectsPanelProps) {
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const folderCounts = projects.reduce<Record<string, number>>((counts, project) => {
    const folderId = project.folderId ?? UNFILED_FOLDER_ID;
    counts[folderId] = (counts[folderId] ?? 0) + 1;
    return counts;
  }, {});
  const visibleProjects = selectedFolderId === null
    ? projects
    : projects.filter((project) => (project.folderId ?? UNFILED_FOLDER_ID) === selectedFolderId);
  const folderOptions = flattenProjectFolders(folders);
  const [name, setName] = useState(suggestedName);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmUnpublish, setConfirmUnpublish] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);
  const [publishingId, setPublishingId] = useState<string | null>(null);
  const [unpublishingId, setUnpublishingId] = useState<string | null>(null);
  // Image upload state: tracks which project/type is currently uploading
  const [imageUploading, setImageUploading] = useState<{ id: string; type: "cover" | "author" } | null>(null);
  // Format export state: tracks which project is showing the format dropdown
  const [showFormats, setShowFormats] = useState<string | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const imageTargetRef = useRef<{ id: string; type: "cover" | "author" } | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const projectFileRef = useRef<HTMLInputElement>(null);
  const manifestFileRef = useRef<HTMLInputElement>(null);

  // Live published catalog fetched from R2 via API
  const [liveBooks, setLiveBooks] = useState<PublishedBookEntry[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [removingSlug, setRemovingSlug] = useState<string | null>(null);
  const [confirmRemoveSlug, setConfirmRemoveSlug] = useState<string | null>(null);

  async function fetchLiveCatalog() {
    setCatalogLoading(true);
    try {
      const res = await fetch("/api/ebook/publish");
      if (res.ok) {
        const data = await res.json() as { books?: PublishedBookEntry[] };
        setLiveBooks(data.books ?? []);
      }
    } catch { /* silently ignore */ }
    finally { setCatalogLoading(false); }
  }

  useEffect(() => { void fetchLiveCatalog(); }, []);

  // Keep the name input in sync when the pipeline produces a title
  useEffect(() => {
    if (suggestedName && !name) setName(suggestedName);
  }, [suggestedName, name]);

  async function handleFormatExport(p: EbookProject, format: "pdf" | "epub" | "docx") {
    setExporting(p.id);
    setShowFormats(null);
    
    try {
      const manifest = buildManifest(p);

      const exportRes = await fetch("/api/ebook/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          manifest,
          formats: {
            pdf: format === "pdf",
            epub: format === "epub",
            docx: format === "docx",
          },
          template: manifest.selectedTemplate || "devotional",
          printSpec: manifest.printSpec,
        }),
      });

      if (!exportRes.ok) {
        const error = await exportRes.json();
        throw new Error(error.error || "Export failed");
      }

      const result = await exportRes.json();
      const url = result[`${format}Url`];
      
      if (!url) throw new Error("No download URL returned");

      // Download the file
      const a = document.createElement("a");
      a.href = url;
      a.download = `${p.name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}.${format}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (error) {
      console.error("Export failed:", error);
      alert(error instanceof Error ? error.message : "Failed to export book");
    } finally {
      setExporting(null);
    }
  }

  function handleProjectFileImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target?.result as string) as EbookProject;
        const now = new Date().toISOString();

        // Accept both Book-only exports and workspace-style project snapshots that carry ebookJobState.
        if (parsed && typeof parsed === "object" && "ebookJobState" in parsed) {
          const snapshot = parsed as unknown as ProjectSnapshot;
          if (!snapshot.id || !snapshot.name || !snapshot.ebookJobState) {
            throw new Error("Invalid ebook project file.");
          }
          const jobParse = EbookJobStateSchema.safeParse(snapshot.ebookJobState);
          if (!jobParse.success) throw new Error("Invalid ebook job state in project file.");

          onImport({
            id: snapshot.id,
            name: snapshot.name,
            createdAt: snapshot.createdAt ?? now,
            updatedAt: now,
            bookTitle: jobParse.data.architecture?.bookTitle ?? snapshot.name,
            chapterCount: jobParse.data.chapters?.length ?? 0,
            totalWordCount: (jobParse.data.chapters ?? []).reduce((sum, chapter) => sum + (chapter.totalWordCount ?? 0), 0),
            status: jobParse.data.status,
            jobState: jobParse.data,
            publishedSlug: snapshot.publishedSlug,
            coverImageUrl: snapshot.coverImageUrl,
            authorImageUrl: snapshot.authorImageUrl,
          });
          setImportSuccess(`"${snapshot.name}" imported into saved projects.`);
          setImportError(null);
          return;
        }

        if (!parsed.id || !parsed.name || !parsed.jobState) throw new Error("Invalid ebook project file.");
        const jobParse = EbookJobStateSchema.safeParse(parsed.jobState);
        if (!jobParse.success) throw new Error("Invalid ebook job state in project file.");
        onImport({
          ...parsed,
          jobState: jobParse.data,
          id: `ebook-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          updatedAt: now,
        });
        setImportSuccess(`"${parsed.name}" imported into saved projects.`);
        setImportError(null);
      } catch {
        setImportError("Could not read file — make sure it's a valid Nexus ebook project export.");
        setImportSuccess(null);
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  function handleManifestFileImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const raw = JSON.parse((ev.target?.result as string) ?? "") as unknown;
        const wrapped = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;

        // Try: direct manifest, wrapped manifest, or wrapped job state
        const candidateManifest = wrapped?.manifest ?? wrapped?.ebookManifest ?? raw;
        const candidateJob      = wrapped?.job ?? wrapped?.jobState ?? raw;

        const manifestParse = EbookManifestSchema.safeParse(candidateManifest);
        if (manifestParse.success) {
          onManifestLoaded?.(manifestParse.data);
          setImportSuccess(`"${manifestParse.data.bookTitle}" loaded into pipeline.`);
          setImportError(null);
          return;
        }

        const jobParse = EbookJobStateSchema.safeParse(candidateJob);
        if (jobParse.success && onImportManifestJson) {
          const manifest = onImportManifestJson(jobParse.data);
          if (!manifest) throw new Error("Job file is valid but book is not yet complete.");
          onManifestLoaded?.(manifest);
          setImportSuccess(`"${manifest.bookTitle}" loaded into pipeline.`);
          setImportError(null);
          return;
        }

        throw new Error("Unsupported file format — import a Nexus ebook manifest or saved project JSON.");
      } catch (err) {
        setImportError(err instanceof Error ? err.message : "Could not import file.");
        setImportSuccess(null);
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  async function handleImageFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    const target = imageTargetRef.current;
    if (!file || !target || !onUpdateImages) return;

    setImageUploading(target);
    try {
      // 1. Get a presigned upload URL from R2
      const presignRes = await fetch("/api/r2-presign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, contentType: file.type, prefix: "images" }),
      });
      if (!presignRes.ok) throw new Error("Could not get upload URL.");
      const { presignedUrl, publicUrl } = await presignRes.json() as { presignedUrl: string; publicUrl: string | null };
      if (!presignedUrl || !publicUrl) throw new Error("Storage not configured.");

      // 2. Upload directly to R2
      const uploadRes = await fetch(presignedUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!uploadRes.ok) throw new Error("Upload failed.");

      // 3. Persist the URL on the project
      await onUpdateImages(
        target.id,
        target.type === "cover"  ? publicUrl : undefined,
        target.type === "author" ? publicUrl : undefined,
      );
    } catch {
      /* silently ignore — user can retry */
    } finally {
      setImageUploading(null);
      imageTargetRef.current = null;
    }
  }

  return (
    <div className="flex flex-col gap-5 rounded-2xl border border-slate-700/60 bg-slate-900/80 backdrop-blur-sm p-5">

      {/* ── Status messages ─────────────────────────────────────────────── */}
      {importError && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">{importError}</p>
      )}
      {importSuccess && (
        <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-400">{importSuccess}</p>
      )}

      {/* ── Save current book ────────────────────────────────────────────── */}
      <div>
        <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-slate-500">Save Current Book</p>
        <div className="flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Enter a name for this book project…"
            className="min-h-12 flex-1 rounded-xl border border-slate-600 bg-slate-800/60 px-4 text-base text-slate-100 placeholder-slate-500 focus:border-cyan-500 focus:outline-none"
          />
          <button
            onClick={() => { if (name.trim()) onSave(name.trim(), selectedFolderId ?? UNFILED_FOLDER_ID); }}
            disabled={!name.trim()}
            className="min-h-12 rounded-xl bg-cyan-600 px-6 text-sm font-semibold text-white transition hover:bg-cyan-500 disabled:opacity-40"
          >
            Save
          </button>
        </div>
        <p className="mt-1.5 text-[11px] text-slate-600">Saves your pipeline progress to this device. Resume any time.</p>
      </div>

      {/* ── Import from device ───────────────────────────────────────────── */}
      <div>
        <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-slate-500">Import from Device</p>
        <div className="flex gap-2">
          <button
            onClick={() => projectFileRef.current?.click()}
            className="flex flex-1 min-h-12 items-center justify-center gap-2 rounded-xl border border-slate-600 bg-slate-800/40 text-sm font-semibold text-slate-300 transition hover:border-cyan-500/50 hover:text-cyan-300 active:scale-[0.97]"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-4 w-4 shrink-0">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" strokeLinecap="round" strokeLinejoin="round" />
              <polyline points="17 8 12 3 7 8" strokeLinecap="round" strokeLinejoin="round" />
              <line x1="12" y1="3" x2="12" y2="15" strokeLinecap="round" />
            </svg>
            Import Project File
          </button>
          {onManifestLoaded && (
            <button
              onClick={() => manifestFileRef.current?.click()}
              className="flex flex-1 min-h-12 items-center justify-center gap-2 rounded-xl border border-slate-600 bg-slate-800/40 text-sm font-semibold text-slate-300 transition hover:border-cyan-500/50 hover:text-cyan-300 active:scale-[0.97]"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-4 w-4 shrink-0">
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Load Manifest JSON
            </button>
          )}
        </div>
        <p className="mt-1.5 text-[11px] text-slate-600">
          Import Project File — restores a full project (all pipeline stages).
          {onManifestLoaded && " Load Manifest JSON — loads a completed ebook export into the pipeline."}
        </p>
        <input ref={projectFileRef}  type="file" accept=".json,application/json" className="hidden" onChange={handleProjectFileImport} />
        <input ref={manifestFileRef} type="file" accept=".json,application/json" className="hidden" onChange={handleManifestFileImport} />
        <input ref={imageInputRef}   type="file" accept="image/*" className="hidden" onChange={handleImageFileChange} />
      </div>

      {/* ── Saved project list ───────────────────────────────────────────── */}
      <div className="grid min-h-0 gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
        <ProjectFolderTree
          folders={folders}
          selectedFolderId={selectedFolderId}
          projectCounts={folderCounts}
          totalProjectCount={projects.length}
          onSelect={setSelectedFolderId}
          onCreate={onCreateFolder}
          onRename={onRenameFolder}
          onDelete={onDeleteFolder}
        />
        <div className="min-w-0">
        <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-slate-500">
          Saved Books {visibleProjects.length > 0 && `· ${visibleProjects.length}`}
        </p>
        {visibleProjects.length === 0 ? (
          <div className="rounded-xl border border-slate-700/40 bg-slate-800/20 p-6 text-center">
            <p className="text-sm text-slate-400">
              {projects.length === 0 ? "No saved books yet." : "No books in this folder."}
            </p>
            <p className="mt-1 text-xs text-slate-600">
              {projects.length === 0
                ? "Complete some pipeline stages, then hit Save above."
                : "Move a book here from its folder menu or choose another folder."}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {visibleProjects.map((p) => (
              <div key={p.id} className="rounded-xl border border-slate-700/50 bg-slate-800/40 p-4">
                <div className="mb-3 flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-slate-100">{p.name}</p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {p.chapterCount > 0
                        ? `${p.chapterCount} chapter${p.chapterCount !== 1 ? "s" : ""}`
                        : p.status === "complete" ? "Complete" : p.status}
                      {p.totalWordCount > 0 && ` · ${p.totalWordCount.toLocaleString()} words`}
                      {" · "}
                      <span>
                        Created {new Date(p.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                      </span>
                      {" · "}
                      <span>
                        Updated {new Date(p.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
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

                <div className="flex flex-wrap gap-2">
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
                  <div className="relative">
                    <button
                      onClick={() => setShowFormats(showFormats === p.id ? null : p.id)}
                      disabled={exporting === p.id}
                      title="Export ebook in readable format"
                      className="flex min-h-10 min-w-[2.75rem] items-center justify-center rounded-lg border border-slate-600 text-slate-400 transition hover:border-cyan-500/50 hover:text-cyan-300 disabled:opacity-50"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-4 w-4">
                        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" strokeLinecap="round" strokeLinejoin="round" />
                        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                    {showFormats === p.id && exporting !== p.id && (
                      <div className="absolute bottom-full left-0 z-10 mb-2 w-40 rounded-xl border-2 border-slate-600 bg-slate-800 shadow-lg">
                        <button
                          onClick={() => handleFormatExport(p, "pdf")}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-slate-700 rounded-t-xl"
                        >
                          <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4 text-red-500">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z" />
                            <path d="M14 2v6h6" />
                          </svg>
                          <span className="font-medium">PDF</span>
                        </button>
                        <button
                          onClick={() => handleFormatExport(p, "epub")}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-slate-700"
                        >
                          <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4 text-green-500">
                            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                          </svg>
                          <span className="font-medium">EPUB</span>
                        </button>
                        <button
                          onClick={() => handleFormatExport(p, "docx")}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-slate-700 rounded-b-xl"
                        >
                          <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4 text-blue-500">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z" />
                            <path d="M14 2v6h6" />
                          </svg>
                          <span className="font-medium">Word</span>
                        </button>
                      </div>
                    )}
                  </div>
                  <label className="order-last flex min-h-12 basis-full items-center gap-2 rounded-lg border border-slate-700/50 bg-slate-900/30 px-3 text-xs text-slate-500">
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
                  <button
                    onClick={() => exportProject(p)}
                    title="Download full project (all pipeline stages)"
                    className="flex min-h-10 min-w-[2.75rem] items-center justify-center rounded-lg border border-slate-600 text-slate-400 transition hover:border-cyan-500/50 hover:text-cyan-300"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-4 w-4">
                      <path d="M12 3v12" strokeLinecap="round" />
                      <polyline points="17 12 12 17 7 12" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M3 17v2a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>

                {/* ── Book images ── */}
                {onUpdateImages && (
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
                        {p.coverImageUrl ? "Cover uploaded" : "Tap to add cover"}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-600">
                        {p.authorImageUrl ? "Author photo set" : "Tap circle for author photo"}
                      </p>
                    </div>
                  </div>
                )}

                {/* Publish / Published row */}
                {onPublish && (
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
                            try {
                              await onPublish(p);
                            } finally {
                              setPublishingId(null);
                            }
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

                        {/* Remove from Library (confirm) */}
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
                                className="flex flex-1 min-h-10 items-center justify-center gap-1.5 rounded-lg bg-red-500/20 text-sm font-semibold text-red-400 transition hover:bg-red-500/30 disabled:opacity-50"
                              >
                                {unpublishingId === p.id ? "Removing…" : "Yes, remove"}
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
                              className="flex min-h-10 w-full items-center justify-center gap-2 rounded-lg border border-red-500/20 text-sm font-medium text-slate-500 transition hover:border-red-500/40 hover:text-red-400"
                            >
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-4 w-4">
                                <path d="M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                              Remove from Library
                            </button>
                          )
                        )}
                      </>
                    ) : (
                      <button
                        onClick={async () => {
                          setPublishingId(p.id);
                          try {
                            await onPublish(p);
                          } finally {
                            setPublishingId(null);
                          }
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
      </div>
      </div>

      {/* ── Library Books (live catalog from R2) ─────────────────────────── */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
            Library Books {liveBooks.length > 0 && `· ${liveBooks.length}`}
          </p>
          <button
            onClick={() => void fetchLiveCatalog()}
            disabled={catalogLoading}
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-semibold uppercase tracking-widest text-slate-500 transition hover:text-slate-300 disabled:opacity-40"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className={`h-3 w-3 ${catalogLoading ? "animate-spin" : ""}`}>
              <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 0 0 4.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 0 1-15.357-2m15.357 2H15" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Refresh
          </button>
        </div>

        {liveBooks.length === 0 ? (
          <div className="rounded-xl border border-slate-700/40 bg-slate-800/20 p-4 text-center">
            <p className="text-sm text-slate-400">{catalogLoading ? "Loading…" : "No books in library yet."}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {liveBooks.map((book) => (
              <div key={book.slug} className="rounded-xl border border-slate-700/50 bg-slate-800/40 p-4">
                {(() => {
                  const linkedProject = projects.find((p) => p.publishedSlug === book.slug);
                  const coverUrl = book.coverImageUrl ?? linkedProject?.coverImageUrl;
                  const authorUrl = book.authorImageUrl ?? linkedProject?.authorImageUrl;
                  return (
                    <>
                {/* Book info */}
                <p className="truncate font-semibold text-slate-100">{book.title}</p>
                {book.subtitle && (
                  <p className="mt-0.5 truncate text-xs text-slate-500 italic">{book.subtitle}</p>
                )}
                <p className="mt-0.5 text-xs text-slate-500">
                  {book.chapterCount} ch · {book.wordCount.toLocaleString()} words
                  {" · "}
                  {new Date(book.publishedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                </p>

                <div className="mt-3 flex items-center gap-3 rounded-xl border border-slate-700/40 bg-slate-800/30 p-3">
                  <div className="relative flex h-16 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-slate-600 bg-slate-800">
                    {coverUrl ? (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img src={coverUrl} alt="Cover" className="h-full w-full object-cover" />
                    ) : (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-5 w-5 text-slate-500">
                        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" strokeLinecap="round" strokeLinejoin="round" />
                        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </div>

                  <div className="relative flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full border border-slate-600 bg-slate-800">
                    {authorUrl ? (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img src={authorUrl} alt="Author" className="h-full w-full object-cover" />
                    ) : (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-5 w-5 text-slate-500">
                        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" strokeLinecap="round" strokeLinejoin="round" />
                        <circle cx="12" cy="7" r="4" strokeLinecap="round" />
                      </svg>
                    )}
                  </div>

                  <div className="min-w-0">
                    <p className="text-xs font-medium text-slate-400">
                      {coverUrl ? "Cover uploaded" : "No cover image"}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-600">
                      {authorUrl ? "Author photo set" : "No author image"}
                    </p>
                  </div>
                </div>

                {/* Actions */}
                <div className="mt-3 flex gap-2">
                  <a
                    href={`/library/${book.slug}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex flex-1 min-h-10 items-center justify-center gap-2 rounded-lg border border-slate-600 text-sm font-semibold text-slate-300 transition hover:border-emerald-500/50 hover:text-emerald-400"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-4 w-4 shrink-0">
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" strokeLinecap="round" strokeLinejoin="round" />
                      <polyline points="15 3 21 3 21 9" strokeLinecap="round" strokeLinejoin="round" />
                      <line x1="10" y1="14" x2="21" y2="3" strokeLinecap="round" />
                    </svg>
                    View
                  </a>

                  {confirmRemoveSlug === book.slug ? (
                    <>
                      <button
                        onClick={async () => {
                          setRemovingSlug(book.slug);
                          setConfirmRemoveSlug(null);
                          try {
                            const res = await fetch("/api/ebook/publish", {
                              method:  "DELETE",
                              headers: { "Content-Type": "application/json" },
                              body:    JSON.stringify({ slug: book.slug }),
                            });
                            if (res.ok) {
                              setLiveBooks((prev) => prev.filter((b) => b.slug !== book.slug));
                            }
                          } finally { setRemovingSlug(null); }
                        }}
                        disabled={removingSlug === book.slug}
                        className="flex flex-1 min-h-10 items-center justify-center rounded-lg bg-red-500/20 text-sm font-semibold text-red-400 transition hover:bg-red-500/30 disabled:opacity-50"
                      >
                        {removingSlug === book.slug ? "Unpublishing…" : "Yes, unpublish"}
                      </button>
                      <button
                        onClick={() => setConfirmRemoveSlug(null)}
                        className="flex flex-1 min-h-10 items-center justify-center rounded-lg bg-slate-700/50 text-sm text-slate-400 transition hover:bg-slate-700"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => setConfirmRemoveSlug(book.slug)}
                      disabled={removingSlug === book.slug}
                      className="flex flex-1 min-h-10 items-center justify-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 text-sm font-semibold text-red-400 transition hover:bg-red-500/20 disabled:opacity-50"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-4 w-4 shrink-0">
                        <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" strokeLinecap="round" strokeLinejoin="round" />
                        <circle cx="12" cy="12" r="3" strokeLinecap="round" />
                      </svg>
                      Unpublish
                    </button>
                  )}
                </div>
                    </>
                  );
                })()}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
