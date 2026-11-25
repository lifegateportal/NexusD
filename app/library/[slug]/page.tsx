import Link from "next/link";
import { notFound } from "next/navigation";
import { EbookManifestSchema } from "@/lib/schemas/ebook";
import { PublishedCatalogSchema } from "@/lib/schemas/published-book";
import ReadingListButton from "./ReadingListButton";
import { DownloadButton } from "./DownloadButton";

export const revalidate = 60;

const ACCENT_HERO: Record<string, string> = {
  amber:   "from-amber-950/90 via-slate-950/60 to-slate-950",
  cyan:    "from-cyan-950/90 via-slate-950/60 to-slate-950",
  emerald: "from-emerald-950/90 via-slate-950/60 to-slate-950",
  rose:    "from-rose-950/90 via-slate-950/60 to-slate-950",
  violet:  "from-violet-950/90 via-slate-950/60 to-slate-950",
  slate:   "from-slate-800/90 via-slate-950/60 to-slate-950",
};

const ACCENT_TEXT: Record<string, string> = {
  amber: "text-amber-400", cyan: "text-cyan-400", emerald: "text-emerald-400",
  rose: "text-rose-400",   violet: "text-violet-400", slate: "text-slate-400",
};

const ACCENT_BG: Record<string, string> = {
  amber: "bg-amber-500 hover:bg-amber-400",
  cyan: "bg-cyan-500 hover:bg-cyan-400",
  emerald: "bg-emerald-500 hover:bg-emerald-400",
  rose: "bg-rose-500 hover:bg-rose-400",
  violet: "bg-violet-500 hover:bg-violet-400",
  slate: "bg-slate-500 hover:bg-slate-400",
};

const ACCENT_BORDER: Record<string, string> = {
  amber: "border-amber-500/30 text-amber-300 bg-amber-500/10",
  cyan: "border-cyan-500/30 text-cyan-300 bg-cyan-500/10",
  emerald: "border-emerald-500/30 text-emerald-300 bg-emerald-500/10",
  rose: "border-rose-500/30 text-rose-300 bg-rose-500/10",
  violet: "border-violet-500/30 text-violet-300 bg-violet-500/10",
  slate: "border-slate-500/30 text-slate-300 bg-slate-500/10",
};

const ACCENT_COVER_GRAD: Record<string, string> = {
  amber:   "from-amber-950 via-amber-900 to-amber-800",
  cyan:    "from-cyan-950 via-cyan-900 to-cyan-800",
  emerald: "from-emerald-950 via-emerald-900 to-emerald-800",
  rose:    "from-rose-950 via-rose-900 to-rose-800",
  violet:  "from-violet-950 via-violet-900 to-violet-800",
  slate:   "from-slate-900 via-slate-800 to-slate-700",
};

const ACCENT_AVATAR: Record<string, string> = {
  amber:   "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  cyan:    "bg-cyan-500/15 text-cyan-300 ring-cyan-500/30",
  emerald: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  rose:    "bg-rose-500/15 text-rose-300 ring-rose-500/30",
  violet:  "bg-violet-500/15 text-violet-300 ring-violet-500/30",
  slate:   "bg-slate-500/15 text-slate-300 ring-slate-500/30",
};

// ── Data fetchers ─────────────────────────────────────────────────────────────

async function fetchManifest(slug: string) {
  const pub = process.env.R2_PUBLIC_URL;
  if (!pub) return null;
  try {
    const res = await fetch(
      `${pub.replace(/\/$/, "")}/published/${slug}/manifest.json`,
      { next: { revalidate: 60 } },
    );
    if (!res.ok) return null;
    const parsed = EbookManifestSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

async function fetchAccent(slug: string): Promise<string> {
  const pub = process.env.R2_PUBLIC_URL;
  if (!pub) return "amber";
  try {
    const res = await fetch(
      `${pub.replace(/\/$/, "")}/published/index.json`,
      { next: { revalidate: 60 } },
    );
    if (!res.ok) return "amber";
    const parsed = PublishedCatalogSchema.safeParse(await res.json());
    return parsed.success
      ? (parsed.data.books.find((b) => b.slug === slug)?.coverAccent ?? "amber")
      : "amber";
  } catch { return "amber"; }
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function BookLandingPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const [manifest, accent] = await Promise.all([
    fetchManifest(slug),
    fetchAccent(slug),
  ]);

  if (!manifest) notFound();

  const heroGrad   = ACCENT_HERO[accent]       ?? ACCENT_HERO.amber;
  const accentText = ACCENT_TEXT[accent]       ?? ACCENT_TEXT.amber;
  const accentBg   = ACCENT_BG[accent]         ?? ACCENT_BG.amber;
  const accentBdr  = ACCENT_BORDER[accent]     ?? ACCENT_BORDER.amber;
  const coverGrad  = ACCENT_COVER_GRAD[accent] ?? ACCENT_COVER_GRAD.amber;
  const avatarCls  = ACCENT_AVATAR[accent]     ?? ACCENT_AVATAR.amber;
  const totalMins  = Math.ceil(manifest.totalWordCount / 200);
  const readTime   = totalMins >= 60 ? `~${Math.round(totalMins / 60)}h` : `~${totalMins} min`;

  return (
    <main className="min-h-dvh bg-slate-950">

      {/* ── Hero gradient band ─────────────────────────────────────────────── */}
      <div className={`bg-gradient-to-b ${heroGrad} pb-16 pt-0`}>
        <div className="mx-auto max-w-6xl px-5">

          {/* Nav */}
          <div className="flex items-center py-5">
            <Link
              href="/library/books"
              className="flex min-h-10 items-center gap-1.5 text-sm font-medium text-slate-400 transition hover:text-slate-300"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-4 w-4">
                <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Library
            </Link>
          </div>

          {/* Two-column hero: cover mockup + text */}
          <div className="flex flex-col items-center gap-10 pt-4 lg:flex-row lg:items-center lg:gap-16 lg:pt-8">

            {/* Book cover mockup or real image */}
            <div className="w-44 shrink-0 lg:w-56">
              <div
                className={`relative h-64 w-full overflow-hidden rounded-2xl ${manifest.coverImageUrl ? "bg-slate-900" : `bg-gradient-to-br ${coverGrad}`} shadow-2xl ring-1 ring-white/10 lg:h-80`}
              >
                {manifest.coverImageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={manifest.coverImageUrl}
                    alt={`${manifest.bookTitle} cover`}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <>
                    <div className="absolute inset-y-0 left-0 w-3 rounded-l-2xl bg-black/30" />
                    <div className="absolute inset-y-2 right-2 w-2 rounded-sm bg-white/[0.08]" />
                    <div className="absolute inset-y-3 right-5 w-1 rounded-sm bg-white/[0.04]" />
                    <div className="absolute inset-x-0 bottom-0 h-1/3 rounded-b-2xl bg-gradient-to-t from-black/60 to-transparent" />
                    <div className="absolute inset-0 flex flex-col items-center justify-center px-5 text-center">
                      <p className="mb-3 text-[9px] font-semibold uppercase tracking-[0.28em] text-white/40">
                        {manifest.authorName}
                      </p>
                      <h2
                        className="text-sm font-bold leading-snug text-white/90"
                        style={{ fontFamily: "Georgia, serif" }}
                      >
                        {manifest.bookTitle}
                      </h2>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Title + meta + CTA */}
            <div className="flex-1 text-center lg:text-left">
              <p className={`mb-3 text-xs font-semibold uppercase tracking-[0.28em] ${accentText}`}>
                {manifest.authorName}
              </p>
              <h1
                className="mb-3 text-4xl font-bold leading-tight tracking-tight text-white lg:text-5xl"
                style={{ fontFamily: "Georgia, serif" }}
              >
                {manifest.bookTitle}
              </h1>
              {manifest.subtitle && (
                <p
                  className="mb-7 text-lg leading-relaxed text-slate-300 lg:text-xl"
                  style={{ fontFamily: "Georgia, serif" }}
                >
                  {manifest.subtitle}
                </p>
              )}

              {/* Stats pills */}
              <div className="mb-8 flex flex-wrap items-center justify-center gap-2.5 lg:justify-start">
                <span className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${accentBdr}`}>
                  {manifest.chapters.length} chapters
                </span>
                <span className="rounded-full border border-slate-700/60 px-3 py-1.5 text-xs font-medium text-slate-400">
                  {manifest.totalWordCount.toLocaleString()} words
                </span>
                <span className="rounded-full border border-slate-700/60 px-3 py-1.5 text-xs font-medium text-slate-400">
                  {readTime} read
                </span>
              </div>

              <div className="flex flex-wrap items-center justify-center gap-3 lg:justify-start">
                <Link
                  href={`/library/${slug}/read`}
                  className={`inline-flex min-h-14 items-center rounded-2xl ${accentBg} px-12 text-base font-bold text-slate-950 shadow-xl transition active:scale-[0.97]`}
                >
                  Start Reading
                </Link>
                <DownloadButton 
                  slug={slug} 
                  bookTitle={manifest.bookTitle}
                  accentBg={accentBg}
                />
                <ReadingListButton
                  accentBg={accentBg}
                  entry={{
                    slug,
                    title:         manifest.bookTitle,
                    authorName:    manifest.authorName,
                    subtitle:      manifest.subtitle ?? undefined,
                    coverAccent:   accent,
                    coverImageUrl: manifest.coverImageUrl ?? null,
                    addedAt:       "",
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Body content ──────────────────────────────────────────────────────── */}
      <div className="mx-auto max-w-6xl px-5 py-12">
        <div className="grid gap-10 lg:grid-cols-[1fr_340px]">

          {/* ── Left: intro + chapter list ──────────────────────────────────── */}
          <div className="space-y-10">

            {manifest.frontMatter.introduction && (
              <section>
                <p className="mb-3 text-[10px] font-bold uppercase tracking-widest text-slate-500">Introduction</p>
                <p className="text-base leading-[1.85] text-slate-300" style={{ fontFamily: "Georgia, serif" }}>
                  {manifest.frontMatter.introduction.replace(/#{1,6} /g, "").trim()}
                </p>
              </section>
            )}

            <section>
              <p className="mb-4 text-[10px] font-bold uppercase tracking-widest text-slate-500">Contents</p>
              <ol className="space-y-1.5">
                {manifest.chapters.map((ch, i) => (
                  <li key={ch.number}>
                    <Link
                      href={`/library/${slug}/read?chapter=${i}`}
                      className="group flex min-h-12 items-center gap-4 rounded-xl border border-slate-800/60 bg-slate-900/30 px-4 py-3 transition hover:border-slate-700/80 hover:bg-slate-900"
                    >
                      <span className={`w-7 shrink-0 text-center text-xs font-bold ${accentText}`}>
                        {ch.number}
                      </span>
                      <span
                        className="flex-1 text-sm font-medium text-slate-300 transition-colors group-hover:text-slate-100"
                        style={{ fontFamily: "Georgia, serif" }}
                      >
                        {ch.title}
                      </span>
                      {ch.totalWordCount > 0 && (
                        <span className="shrink-0 text-xs text-slate-600">
                          {Math.ceil(ch.totalWordCount / 200)} min
                        </span>
                      )}
                    </Link>
                  </li>
                ))}
              </ol>
            </section>
          </div>

          {/* ── Right sidebar ───────────────────────────────────────────────── */}
          <div className="space-y-5 lg:sticky lg:top-6 lg:self-start">

            {/* Author bio card */}
            {manifest.frontMatter.aboutAuthor && (
              <div className="rounded-2xl border border-slate-800/60 bg-slate-900/40 p-5">
                <div className="mb-4 flex items-center gap-3">
                  {manifest.authorImageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={manifest.authorImageUrl}
                      alt={manifest.authorName}
                      className={`h-20 w-20 shrink-0 rounded-full object-cover ring-2 ${avatarCls.replace(/bg-[^\s]+\s*/, "")}`}
                    />
                  ) : (
                    <div
                      className={`flex h-20 w-20 shrink-0 items-center justify-center rounded-full text-lg font-bold ring-1 ${avatarCls}`}
                    >
                      {manifest.authorName.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div>
                    <p className="text-sm font-semibold text-slate-200">{manifest.authorName}</p>
                    <p className="text-[10px] uppercase tracking-widest text-slate-500">Author</p>
                  </div>
                </div>
                <p className="text-sm leading-relaxed text-slate-300">
                  {manifest.frontMatter.aboutAuthor}
                </p>
              </div>
            )}

          </div>

        </div>
      </div>
    </main>
  );
}
