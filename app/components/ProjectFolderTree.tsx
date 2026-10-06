"use client";

import { useEffect, useMemo, useState } from "react";
import {
  flattenProjectFolders,
  UNFILED_FOLDER_ID,
  type ProjectFolder,
} from "@/lib/project-organization-store";

type ProjectFolderTreeProps = {
  folders: ProjectFolder[];
  selectedFolderId: string | null;
  projectCounts: Record<string, number>;
  totalProjectCount: number;
  onSelect: (folderId: string | null) => void;
  onCreate: (name: string, parentId: string | null) => void | Promise<void>;
  onRename: (folderId: string, name: string) => void | Promise<void>;
  onDelete: (folderId: string) => void | Promise<void>;
};

export function ProjectFolderTree({
  folders,
  selectedFolderId,
  projectCounts,
  totalProjectCount,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: ProjectFolderTreeProps) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newParentId, setNewParentId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  const orderedFolders = useMemo(() => flattenProjectFolders(folders), [folders]);
  const selectableParents = orderedFolders.filter((folder) => folder.id !== UNFILED_FOLDER_ID);

  useEffect(() => {
    if (selectedFolderId && !folders.some((folder) => folder.id === selectedFolderId)) {
      onSelect(null);
    }
  }, [folders, onSelect, selectedFolderId]);

  async function submitNewFolder() {
    const name = newName.trim();
    if (!name) return;
    await onCreate(name, newParentId);
    setNewName("");
    setNewParentId(null);
    setCreating(false);
  }

  async function submitRename() {
    const name = editingName.trim();
    if (!editingId || !name) return;
    await onRename(editingId, name);
    setEditingId(null);
    setEditingName("");
  }

  return (
    <aside className="flex min-w-0 flex-col gap-2 rounded-xl border border-slate-700/50 bg-slate-900/40 p-3 lg:min-h-0">
      <div className="flex items-center justify-between gap-2 px-1">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Organize</p>
          <p className="text-sm font-semibold text-slate-200">Project folders</p>
        </div>
        <button
          type="button"
          onClick={() => setCreating((value) => !value)}
          aria-label="Create folder"
          className="flex min-h-12 min-w-12 items-center justify-center rounded-lg border border-cyan-500/30 px-2 text-xs font-semibold text-cyan-300 transition hover:border-cyan-400 hover:bg-cyan-500/10"
        >
          New
        </button>
      </div>

      {creating && (
        <div className="flex flex-col gap-2 rounded-lg border border-cyan-500/20 bg-cyan-500/5 p-2">
          <input
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submitNewFolder();
              if (event.key === "Escape") setCreating(false);
            }}
            autoFocus
            placeholder="Folder name"
            className="min-h-12 rounded-lg border border-slate-600 bg-slate-800/70 px-3 text-base text-slate-100 placeholder-slate-500 focus:border-cyan-500 focus:outline-none"
          />
          <select
            value={newParentId ?? ""}
            onChange={(event) => setNewParentId(event.target.value || null)}
            aria-label="Parent folder"
            className="min-h-12 rounded-lg border border-slate-600 bg-slate-800/70 px-3 text-base text-slate-200 focus:border-cyan-500 focus:outline-none"
          >
            <option value="">Top-level folder</option>
            {selectableParents.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.name}
              </option>
            ))}
          </select>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void submitNewFolder()}
              disabled={!newName.trim()}
              className="min-h-12 flex-1 rounded-lg bg-cyan-600 px-3 text-sm font-semibold text-white transition hover:bg-cyan-500 disabled:opacity-40"
            >
              Create
            </button>
            <button
              type="button"
              onClick={() => setCreating(false)}
              className="min-h-12 rounded-lg border border-slate-600 px-3 text-sm text-slate-300 transition hover:border-slate-500"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-1">
        <FolderButton
          label="All projects"
          count={totalProjectCount}
          active={selectedFolderId === null}
          onClick={() => onSelect(null)}
        />
        {orderedFolders.map((folder) => {
          const depth = getFolderDepth(folder, folders);
          const isEditing = editingId === folder.id;

          if (isEditing) {
            return (
              <div key={folder.id} className="flex items-center gap-1" style={{ paddingLeft: `${depth * 16}px` }}>
                <input
                  value={editingName}
                  onChange={(event) => setEditingName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void submitRename();
                    if (event.key === "Escape") {
                      setEditingId(null);
                      setEditingName("");
                    }
                  }}
                  autoFocus
                  className="min-h-12 min-w-0 flex-1 rounded-lg border border-cyan-500 bg-slate-800 px-2 text-base text-slate-100 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => void submitRename()}
                  aria-label={`Save ${folder.name}`}
                  title="Save folder name"
                  className="flex min-h-12 min-w-12 items-center justify-center rounded-lg text-emerald-300 transition hover:bg-emerald-500/10"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-5 w-5" aria-hidden="true">
                    <path d="m5 12 4 4L19 6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>
            );
          }

          return (
            <div key={folder.id} className="group flex items-center gap-1" style={{ paddingLeft: `${depth * 16}px` }}>
              <FolderButton
                label={folder.name}
                count={projectCounts[folder.id] ?? 0}
                active={selectedFolderId === folder.id}
                onClick={() => onSelect(folder.id)}
              />
              {folder.id !== UNFILED_FOLDER_ID && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(folder.id);
                      setEditingName(folder.name);
                    }}
                    aria-label={`Rename ${folder.name}`}
                    title="Rename folder"
                    className="flex min-h-12 min-w-12 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-700/50 hover:text-cyan-300"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-5 w-5" aria-hidden="true">
                      <path d="M12 20h9" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L8 18l-4 1 1-4L16.5 3.5z" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => void onDelete(folder.id)}
                    aria-label={`Delete ${folder.name}`}
                    title="Delete folder"
                    className="flex min-h-12 min-w-12 items-center justify-center rounded-lg text-slate-500 transition hover:bg-red-500/10 hover:text-red-300"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-5 w-5" aria-hidden="true">
                      <polyline points="3 6 5 6 21 6" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="m19 6-1 14H6L5 6m3 0V4h8v2M10 11v5M14 11v5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function FolderButton({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex min-h-12 min-w-0 flex-1 items-center justify-between gap-2 rounded-lg px-3 text-left text-sm transition ${
        active
          ? "bg-cyan-500/15 text-cyan-200 ring-1 ring-cyan-500/30"
          : "text-slate-400 hover:bg-slate-800 hover:text-slate-200"
      }`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span aria-hidden="true" className="text-xs text-slate-500">[]</span>
        <span className="truncate">{label}</span>
      </span>
      <span className="shrink-0 text-xs text-slate-500">{count}</span>
    </button>
  );
}

function getFolderDepth(folder: ProjectFolder, folders: ProjectFolder[]): number {
  const byId = new Map(folders.map((item) => [item.id, item]));
  let depth = 0;
  let parentId = folder.parentId;
  const visited = new Set<string>();
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    depth += 1;
    parentId = parent.parentId;
  }
  return depth;
}
