"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { getReadingList, removeFromReadingList, type ReadingListEntry } from "@/lib/reading-list-store";

const COVER_GRADIENT: Record<string, string> = {
  amber:   "from-amber-950 via-amber-900 to-amber-800",
  cyan:    "from-cyan-950 via-cyan-900 to-cyan-800",
  emerald: "from-emerald-950 via-emerald-900 to-emerald-800",
  rose:    "from-rose-950 via-rose-900 to-rose-800",
  violet:  "from-violet-950 via-violet-900 to-violet-800",
  slate:   "from-slate-900 via-slate-800 to-slate-700",
};

const ACCENT_TEXT: Record<string, string> = {
  amber: "text-amber-400", cyan: "text-cyan-400", emerald: "text-emerald-400",
  rose: "text-rose-400",   violet: "text-violet-400", slate: "text-slate-400",
};

function MiniCover({ entry }: { entry: ReadingListEntry }) {
  const grad = COVER_GRADIENT[entry.coverAccent] ?? COVER_GRADIENT.amber;
  return (
    <div className={`relative h-20 w-14 flex-shrink-0 overflow-hidden rounded-lg shadow-lg shadow-black/40 ring-1 ring-white/10 ${entry.coverImageUrl ? "bg-slate-900" : `bg-gradient-to-br ${grad}`}`}>
      {entry.coverImageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={entry.coverImageUrl} alt={entry.title} className="h-full w-full object-cover" />
      ) : (
        <>
          <div className="absolute inset-y-0 left-0 w-2 bg-black/25" />
          <div className="absolute inset-0 flex items-center justify-center px-1.5 text-center">
            <p className="line-clamp-3 text-[8px] font-bold leading-tight text-white/80" style={{ fontFamily: "Georgia, serif" }}>
              {entry.title}
            </p>
          </div>
        </>
      )}
    </div>
  );
}

export default function MyListPanel({ colorMode }: { colorMode: "dark" | "light" }) {
  const light = colorMode === "light";
  const [list, setList] = useState<ReadingListEntry[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setList(getReadingList());
  }, [open]); // refresh when panel opens

  function handleRemove(slug: string) {
    removeFromReadingList(slug);
    setList(getReadingList());
  }

  if (list.length === 0 && !open) return null;

  return (
    <section className={`border-b py-8 ${light ? "border-slate-200" : "border-slate-800/50"}`}>
      {/* Header row */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-12 w-full items-center justify-between"
      >
        <div className="flex items-center gap-3">
          <p className={`text-[10px] font-bold uppercase tracking-[0.22em] ${light ? "text-slate-600" : "text-slate-400"}`}>My Reading List</p>
          {list.length > 0 && (
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${light ? "bg-slate-200 text-slate-700" : "bg-slate-800 text-slate-400"}`}>
              {list.length}
            </span>
          )}
        </div>
        <svg
          viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
          className={`h-4 w-4 transition-transform ${light ? "text-slate-600" : "text-slate-500"} ${open ? "rotate-180" : ""}`}
        >
          <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="mt-5">
          {list.length === 0 ? (
            <div className={`rounded-2xl border px-6 py-10 text-center ${light ? "border-slate-200 bg-white" : "border-slate-800/60 bg-slate-900/40"}`}>
              <p className={`mb-1 text-sm font-semibold ${light ? "text-slate-600" : "text-slate-400"}`}>Your list is empty</p>
              <p className={`text-xs ${light ? "text-slate-500" : "text-slate-600"}`}>Open any book and tap &ldquo;Save to List&rdquo; to add it here.</p>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {list.map((entry) => {
                const accentT = ACCENT_TEXT[entry.coverAccent] ?? ACCENT_TEXT.amber;
                return (
                  <div key={entry.slug} className={`group flex items-center gap-4 rounded-2xl border p-4 transition hover:border-slate-700/60 ${light ? "border-slate-200 bg-white" : "border-slate-800/60 bg-slate-900/40"}`}>
                    <Link href={`/library/${entry.slug}`} className="contents">
                      <MiniCover entry={entry} />
                      <div className="min-w-0 flex-1">
                        <p className={`mb-0.5 text-[10px] font-semibold uppercase tracking-wider ${light ? "text-slate-700" : accentT}`}>
                          {entry.authorName}
                        </p>
                        <h3 className={`line-clamp-2 text-sm font-bold leading-tight ${light ? "text-slate-900" : "text-slate-100"}`} style={{ fontFamily: "Georgia, serif" }}>
                          {entry.title}
                        </h3>
                        {entry.subtitle && (
                          <p className={`mt-0.5 line-clamp-1 text-xs ${light ? "text-slate-600" : "text-slate-500"}`}>{entry.subtitle}</p>
                        )}
                        <p className={`mt-2 text-xs font-semibold ${light ? "text-slate-600" : "text-slate-500"}`}>
                          {new Date(entry.addedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                        </p>
                      </div>
                    </Link>
                    {/* Remove button */}
                    <button
                      onClick={() => handleRemove(entry.slug)}
                      aria-label="Remove from list"
                      className="ml-1 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-slate-600 transition hover:bg-slate-800 hover:text-slate-400"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className="h-4 w-4">
                        <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
