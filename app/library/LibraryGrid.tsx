"use client";

import { useState } from "react";
import Link from "next/link";
import type { PublishedBookEntry } from "@/lib/schemas/published-book";

// ── Theme maps ────────────────────────────────────────────────────────────────

const COVER_GRADIENT: Record<string, string> = {
  amber:   "from-amber-950 via-amber-900 to-amber-800",
  cyan:    "from-cyan-950 via-cyan-900 to-cyan-800",
  emerald: "from-emerald-950 via-emerald-900 to-emerald-800",
  rose:    "from-rose-950 via-rose-900 to-rose-800",
  violet:  "from-violet-950 via-violet-900 to-violet-800",
  slate:   "from-slate-900 via-slate-800 to-slate-700",
};

const COVER_TITLE: Record<string, string> = {
  amber:   "text-amber-100",
  cyan:    "text-cyan-100",
  emerald: "text-emerald-100",
  rose:    "text-rose-100",
  violet:  "text-violet-100",
  slate:   "text-slate-100",
};

const ACCENT_BADGE: Record<string, string> = {
  amber:   "bg-amber-500/20 text-amber-300 border-amber-500/30",
  cyan:    "bg-cyan-500/20 text-cyan-300 border-cyan-500/30",
  emerald: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
  rose:    "bg-rose-500/20 text-rose-300 border-rose-500/30",
  violet:  "bg-violet-500/20 text-violet-300 border-violet-500/30",
  slate:   "bg-slate-500/20 text-slate-300 border-slate-500/30",
};

// ── Book card ─────────────────────────────────────────────────────────────────

function BookCard({ book }: { book: PublishedBookEntry }) {
  const accent = book.coverAccent ?? "amber";
  const grad   = COVER_GRADIENT[accent] ?? COVER_GRADIENT.amber;
  const title  = COVER_TITLE[accent]    ?? COVER_TITLE.amber;
  const badge  = ACCENT_BADGE[accent]   ?? ACCENT_BADGE.amber;
  const mins   = Math.ceil(book.wordCount / 200);

  return (
    <Link href={`/library/${book.slug}`} className="group block">
      {/* Book cover illustration */}
      {/* Book cover — real photo if available, gradient fallback */}
      <div
        className={`relative mb-4 h-64 w-full overflow-hidden rounded-2xl ${book.coverImageUrl ? "bg-slate-900" : `bg-gradient-to-br ${grad}`} shadow-xl ring-1 ring-white/5 transition duration-300 group-hover:scale-[1.02] group-hover:shadow-2xl group-hover:ring-white/10`}
      >
        {book.coverImageUrl ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={book.coverImageUrl}
            alt={`${book.title} cover`}
            className="h-full w-full object-cover"
          />
        ) : (
          <>
            {/* Spine */}
            <div className="absolute inset-y-0 left-0 w-3 bg-black/25" />
            {/* Page edges */}
            <div className="absolute inset-y-2 right-2 w-2 rounded-sm bg-white/[0.06]" />
            <div className="absolute inset-y-3 right-5 w-1 rounded-sm bg-white/[0.03]" />
            {/* Bottom gradient */}
            <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-black/70 to-transparent" />
            {/* Cover text */}
            <div className="absolute inset-0 flex flex-col items-center justify-center px-7 text-center">
              <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.22em] text-white/40">
                {book.authorName}
              </p>
              <h2
                className={`text-xl font-bold leading-snug tracking-tight ${title}`}
                style={{ fontFamily: "Georgia, serif" }}
              >
                {book.title}
              </h2>
              {book.subtitle && (
                <p
                  className="mt-2 text-sm leading-snug text-white/45"
                  style={{ fontFamily: "Georgia, serif" }}
                >
                  {book.subtitle}
                </p>
              )}
            </div>
          </>
        )}
      </div>

      {/* Below-cover metadata */}
      <div className="px-0.5">
        <h3 className="mb-1 font-semibold leading-snug text-slate-100 transition-colors group-hover:text-white">
          {book.title}
        </h3>
        <p className="mb-3 line-clamp-2 text-sm leading-relaxed text-slate-400">
          {book.synopsis}
        </p>
        <div className="flex flex-wrap gap-1.5">
          <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${badge}`}>
            {book.chapterCount} ch
          </span>
          <span className="inline-flex items-center rounded-full border border-slate-700/50 px-2.5 py-1 text-xs font-medium text-slate-500">
            {mins >= 60 ? `${Math.round(mins / 60)}h` : `${mins} min`}
          </span>
          <span className="inline-flex items-center rounded-full border border-slate-700/50 px-2.5 py-1 text-xs font-medium text-slate-500">
            {book.wordCount.toLocaleString()} words
          </span>
        </div>
      </div>
    </Link>
  );
}

// ── Grid with search ──────────────────────────────────────────────────────────

export default function LibraryGrid({ books }: { books: PublishedBookEntry[] }) {
  const [query, setQuery] = useState("");

  const filtered = query.trim()
    ? books.filter((b) => {
        const q = query.toLowerCase();
        return (
          b.title.toLowerCase().includes(q) ||
          b.authorName.toLowerCase().includes(q) ||
          b.synopsis.toLowerCase().includes(q)
        );
      })
    : books;

  return (
    <div>
      {/* Search input */}
      <div className="relative mb-8">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
        >
          <path d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search books, authors…"
          className="w-full rounded-xl border border-slate-700/60 bg-slate-900/60 py-3 pl-11 pr-4 text-base text-slate-200 placeholder-slate-600 outline-none transition focus:border-slate-500 focus:ring-1 focus:ring-slate-600"
        />
      </div>

      {/* Book count */}
      <p className="mb-8 text-xs font-medium text-slate-600">
        {filtered.length} {filtered.length === 1 ? "book" : "books"}
        {query ? ` matching "${query}"` : " published"}
      </p>

      {filtered.length === 0 ? (
        <div className="flex min-h-[30vh] flex-col items-center justify-center text-center">
          <p className="mb-1 text-slate-400">No books match your search.</p>
          <button
            onClick={() => setQuery("")}
            className="mt-3 inline-flex min-h-12 items-center px-4 text-sm text-slate-400 underline-offset-2 transition hover:text-white hover:underline"
          >
            Clear search
          </button>
        </div>
      ) : (
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((book) => (
            <BookCard key={book.slug} book={book} />
          ))}
        </div>
      )}
    </div>
  );
}
