import Link from "next/link";
import { PublishedCatalogSchema } from "@/lib/schemas/published-book";
import type { PublishedBookEntry } from "@/lib/schemas/published-book";
import LibraryGrid from "./LibraryGrid";
import MyListPanel from "./MyListPanel";
import LibraryNav from "./LibraryNav";

export const revalidate = 60;

// ── Data fetch ────────────────────────────────────────────────────────────────

async function fetchCatalog() {
  const publicUrl = process.env.R2_PUBLIC_URL;
  if (!publicUrl) return null;
  try {
    const res = await fetch(
      `${publicUrl.replace(/\/$/, "")}/published/index.json`,
      { next: { revalidate: 60 } },
    );
    if (!res.ok) return null;
    const parsed = PublishedCatalogSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

// ── New Releases Hero ─────────────────────────────────────────────────────────

const ACCENT_BADGE: Record<string, string> = {
  amber:   "bg-amber-500/15 text-amber-400 border-amber-500/30",
  cyan:    "bg-cyan-500/15 text-cyan-400 border-cyan-500/30",
  emerald: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  rose:    "bg-rose-500/15 text-rose-400 border-rose-500/30",
  violet:  "bg-violet-500/15 text-violet-400 border-violet-500/30",
  slate:   "bg-slate-500/15 text-slate-400 border-slate-500/30",
};

const COVER_GRADIENT: Record<string, string> = {
  amber:   "from-amber-950 via-amber-900 to-amber-800",
  cyan:    "from-cyan-950 via-cyan-900 to-cyan-800",
  emerald: "from-emerald-950 via-emerald-900 to-emerald-800",
  rose:    "from-rose-950 via-rose-900 to-rose-800",
  violet:  "from-violet-950 via-violet-900 to-violet-800",
  slate:   "from-slate-900 via-slate-800 to-slate-700",
};

const COVER_TITLE_COLOR: Record<string, string> = {
  amber:   "text-amber-100",
  cyan:    "text-cyan-100",
  emerald: "text-emerald-100",
  rose:    "text-rose-100",
  violet:  "text-violet-100",
  slate:   "text-slate-100",
};

function BookCover({ book, className }: { book: PublishedBookEntry; className?: string }) {
  const accent = book.coverAccent ?? "amber";
  const grad   = COVER_GRADIENT[accent] ?? COVER_GRADIENT.amber;
  const titleC = COVER_TITLE_COLOR[accent] ?? COVER_TITLE_COLOR.amber;
  return (
    <div className={`relative flex-shrink-0 overflow-hidden rounded-xl shadow-2xl shadow-black/60 ring-1 ring-white/10 ${book.coverImageUrl ? "bg-slate-900" : `bg-gradient-to-br ${grad}`} ${className ?? ""}`}>
      {book.coverImageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={book.coverImageUrl} alt={book.title} className="h-full w-full object-cover" />
      ) : (
        <>
          <div className="absolute inset-y-0 left-0 w-2.5 bg-black/25" />
          <div className="absolute inset-y-2 right-1.5 w-1.5 rounded-sm bg-white/[0.06]" />
          <div className="absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-black/70 to-transparent" />
          <div className="absolute inset-0 flex flex-col items-center justify-center overflow-hidden px-2 text-center">
            <p className="mb-1 w-full truncate text-[8px] font-semibold uppercase tracking-[0.15em] text-white/40">{book.authorName}</p>
            <h2 className={`line-clamp-4 text-[10px] font-bold leading-snug tracking-tight ${titleC}`} style={{ fontFamily: "Georgia, serif" }}>
              {book.title}
            </h2>
          </div>
        </>
      )}
    </div>
  );
}

function NewReleasesHero({ books }: { books: PublishedBookEntry[] }) {
  const recent = [...books]
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
    .slice(0, 5);

  const [featured, ...shelf] = recent;

  return (
    <section className="border-b border-slate-800/50 pb-10 pt-6 lg:py-14">
      <p className="mb-4 text-[10px] font-bold uppercase tracking-[0.28em] text-amber-500 lg:mb-6">
        New Releases
      </p>

      {/* ── Mobile: cinematic portrait card ───────────────────────────────── */}
      <div className="lg:hidden">
        <Link href={`/library/${featured.slug}`} className="group relative block overflow-hidden rounded-2xl border border-slate-800/60">
          {/* Full-bleed cover */}
          <div className={`relative h-[58vw] min-h-[220px] w-full bg-gradient-to-br ${COVER_GRADIENT[featured.coverAccent] ?? COVER_GRADIENT.amber}`}>
            {featured.coverImageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={featured.coverImageUrl} alt={featured.title} className="h-full w-full object-cover" />
            ) : (
              <>
                <div className="absolute inset-y-0 left-0 w-3 bg-black/25" />
                <div className="absolute inset-y-2 right-2 w-2 rounded-sm bg-white/[0.06]" />
              </>
            )}
            {/* Gradient overlay — text lives here */}
            <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/60 to-transparent" />
            <div className="absolute bottom-0 left-0 right-0 p-5">
              <span className={`mb-3 inline-block rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest ${ACCENT_BADGE[featured.coverAccent] ?? ACCENT_BADGE.amber}`}>
                Latest Release
              </span>
              <h2 className="mb-1 text-xl font-bold leading-tight tracking-tight text-white" style={{ fontFamily: "Georgia, serif" }}>
                {featured.title}
              </h2>
              {featured.subtitle && <p className="mb-2 text-sm text-slate-400">{featured.subtitle}</p>}
              <div className="flex items-center gap-2">
                <p className="text-sm font-semibold text-slate-300">{featured.authorName}</p>
                <span className="text-slate-600">·</span>
                <p className="text-xs text-slate-500">{featured.chapterCount} chapters</p>
              </div>
            </div>
          </div>
          {/* Synopsis below */}
          <div className="bg-slate-900/80 px-5 py-4">
            <p className="line-clamp-2 text-sm leading-relaxed text-slate-400">{featured.synopsis}</p>
          </div>
        </Link>

        {/* Horizontal shelf */}
        {shelf.length > 0 && (
          <div className="mt-4">
            <p className="mb-3 text-[10px] font-bold uppercase tracking-[0.22em] text-slate-500">Also New</p>
            <div className="flex gap-3 overflow-x-auto pb-2" style={{ scrollSnapType: "x mandatory", WebkitOverflowScrolling: "touch" }}>
              {shelf.map((book) => (
                <Link
                  key={book.slug}
                  href={`/library/${book.slug}`}
                  className="group flex-shrink-0"
                  style={{ scrollSnapAlign: "start", width: "38vw", maxWidth: "160px" }}
                >
                  <BookCover book={book} className="mb-2.5 h-[25vw] max-h-[110px] w-full" />
                  <p className="line-clamp-2 text-xs font-semibold leading-tight text-slate-200" style={{ fontFamily: "Georgia, serif" }}>
                    {book.title}
                  </p>
                  <p className="mt-0.5 truncate text-[10px] text-slate-500">{book.authorName}</p>
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Desktop: 3-col grid ───────────────────────────────────────────── */}
      <div className="hidden gap-4 lg:grid lg:grid-cols-3">
        <Link
          href={`/library/${featured.slug}`}
          className="group relative col-span-2 overflow-hidden rounded-2xl border border-slate-800/60 bg-slate-900/60 transition hover:border-slate-700"
        >
          {featured.coverImageUrl && (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={featured.coverImageUrl} alt="" aria-hidden className="absolute inset-0 h-full w-full object-cover opacity-20" />
              <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/85 to-slate-950/40" />
            </>
          )}
          <div className="relative flex items-end gap-8 p-8">
            <BookCover book={featured} className="h-64 w-44 flex-shrink-0 self-start transition-transform duration-300 group-hover:scale-[1.03]" />
            <div className="flex-1 pb-2">
              <span className={`mb-4 inline-block rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest ${ACCENT_BADGE[featured.coverAccent] ?? ACCENT_BADGE.amber}`}>
                Latest Release
              </span>
              <h2 className="mb-1 text-3xl font-bold leading-tight tracking-tight text-white" style={{ fontFamily: "Georgia, serif" }}>
                {featured.title}
              </h2>
              {featured.subtitle && <p className="mb-3 text-sm text-slate-400">{featured.subtitle}</p>}
              <p className="mb-5 line-clamp-3 text-sm leading-relaxed text-slate-400">{featured.synopsis}</p>
              <div className="flex items-center gap-3">
                <p className="text-sm font-semibold text-slate-300">{featured.authorName}</p>
                <span className="text-slate-600">·</span>
                <p className="text-xs text-slate-500">{featured.chapterCount} chapters</p>
              </div>
            </div>
          </div>
        </Link>

        <div className="flex flex-col gap-4">
          {shelf.slice(0, 2).map((book) => (
            <Link
              key={book.slug}
              href={`/library/${book.slug}`}
              className="group relative overflow-hidden rounded-2xl border border-slate-800/60 bg-slate-900/60 transition hover:border-slate-700"
            >
              {book.coverImageUrl && (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={book.coverImageUrl} alt="" aria-hidden className="absolute inset-0 h-full w-full object-cover opacity-15" />
                  <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/85 to-slate-950/30" />
                </>
              )}
              <div className="relative flex items-center gap-4 p-4">
                <BookCover book={book} className="h-24 w-16 flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <span className={`mb-2 inline-block rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest ${ACCENT_BADGE[book.coverAccent] ?? ACCENT_BADGE.amber}`}>
                    New
                  </span>
                  <h3 className="mb-1 line-clamp-2 font-bold leading-tight text-white" style={{ fontFamily: "Georgia, serif" }}>
                    {book.title}
                  </h3>
                  <p className="line-clamp-2 text-xs leading-relaxed text-slate-400">{book.synopsis}</p>
                  <p className="mt-2 text-xs font-semibold text-slate-400">{book.authorName}</p>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function LibraryPage() {
  const catalog    = await fetchCatalog();
  const configured = !!process.env.R2_PUBLIC_URL;

  return (
    <main className="min-h-dvh bg-slate-950 pb-20 lg:pl-64 lg:pb-0">
      <LibraryNav />

      {/* ── Sticky nav ──────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-10 border-b border-slate-800/60 bg-slate-950/90 px-5 py-4 backdrop-blur-xl">
        <div className="mx-auto max-w-6xl">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-600">Nexus</p>
          <h1 className="text-xl font-bold tracking-tight text-slate-100">Library</h1>
        </div>
      </header>

      <section className="mx-auto grid max-w-6xl gap-5 px-5 py-8 lg:grid-cols-[1fr_auto] lg:items-end lg:py-12">
        <div>
          <p className="mb-3 text-[10px] font-bold uppercase tracking-[0.25em] text-amber-400">Read · Listen · Discover</p>
          <h2 className="max-w-3xl text-3xl font-bold leading-tight tracking-tight text-white sm:text-4xl" style={{ fontFamily: "Georgia, serif" }}>
            Your ideas, ready to be explored.
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-slate-400 sm:text-base">
            Browse the books, ask questions answered from the author's words, or jump straight to the right moment in a video.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Link href="/library/ask" className="flex min-h-12 items-center rounded-xl bg-amber-500 px-5 text-sm font-bold text-slate-950">
            Ask the library
          </Link>
          <Link href="/library/videos" className="flex min-h-12 items-center rounded-xl border border-slate-700 px-5 text-sm font-semibold text-slate-200">
            Browse videos
          </Link>
        </div>
      </section>

      {!configured ? (
        <div className="flex min-h-[55vh] flex-col items-center justify-center px-5 text-center">
          <div className="mb-5 text-5xl">📚</div>
          <p className="mb-2 text-lg font-semibold text-slate-200">Library not configured</p>
          <p className="max-w-sm text-sm leading-relaxed text-slate-500">
            Set{" "}
            <code className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-amber-300">
              R2_PUBLIC_URL
            </code>{" "}
            in your environment to enable the public reading library.
          </p>
        </div>
      ) : !catalog || catalog.books.length === 0 ? (
        <div className="flex min-h-[55vh] flex-col items-center justify-center px-5 text-center">
          <div className="mb-5 text-5xl">📖</div>
          <p className="mb-2 text-lg font-semibold text-slate-200">No books published yet</p>
          <p className="max-w-sm text-sm leading-relaxed text-slate-500">
            Complete a book in Nexus Director and click &quot;Publish to Library&quot; to see it here.
          </p>
          <Link
            href="/ebook"
            className="mt-6 flex min-h-11 items-center rounded-xl bg-amber-500 px-6 text-sm font-semibold text-slate-950 transition hover:bg-amber-400"
          >
            Open Ebook Pipeline →
          </Link>
        </div>
      ) : (
        <div className="mx-auto max-w-6xl px-5">

          {/* ── New Releases Hero ─────────────────────────────────────────── */}
          <NewReleasesHero books={catalog.books} />

          {/* ── Personal reading list ─────────────────────────────────────── */}
          <MyListPanel />

          {/* ── Full grid ────────────────────────────────────────────────── */}
          <div className="py-10 pb-24 lg:pb-12">
            <p className="mb-6 text-[10px] font-bold uppercase tracking-[0.22em] text-slate-500">All Books</p>
            <LibraryGrid books={catalog.books} />
          </div>

        </div>
      )}
    </main>
  );
}

