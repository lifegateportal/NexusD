import Link from "next/link";
import LibraryHero from "./LibraryHero";
import LibraryNav from "./LibraryNav";
import { LibraryBookCard } from "./LibraryGrid";
import { readLibraryBranding } from "@/lib/library-branding-store";
import { readLibraryWelcomeContent } from "@/lib/library-welcome-content";
import type { LibraryVideo } from "@/lib/schemas/library-video";
import type { LibraryBranding } from "@/lib/schemas/library-branding";
import type { PublishedBookEntry } from "@/lib/schemas/published-book";

type PublicShort = Awaited<ReturnType<typeof readLibraryWelcomeContent>>["shorts"][number];

const ACCENT_TEXT: Record<LibraryBranding["accentColor"], string> = {
  amber: "text-amber-400",
  cyan: "text-cyan-400",
  emerald: "text-emerald-400",
  rose: "text-rose-400",
  violet: "text-violet-400",
};

const FEATURED_ROW_CLASS = "flex min-w-0 snap-x snap-mandatory gap-4 overflow-x-auto overscroll-x-contain pb-3 [scrollbar-width:thin] touch-pan-x";

function chooseSermons(videos: LibraryVideo[], ids: string[]) {
  if (ids.length) {
    const byId = new Map(videos.map((video) => [video.videoId, video]));
    return ids.flatMap((id) => {
      const video = byId.get(id);
      return video ? [video] : [];
    });
  }
  return [...videos]
    .sort((a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime())
    .slice(0, 4);
}

function chooseShorts(shorts: PublicShort[], slugs: string[]) {
  if (slugs.length) {
    const bySlug = new Map(shorts.map((short) => [short.slug, short]));
    return slugs.flatMap((slug) => {
      const short = bySlug.get(slug);
      return short ? [short] : [];
    });
  }
  return shorts.slice(0, 4);
}

function chooseBooks(books: PublishedBookEntry[], slugs: string[]) {
  const bySlug = new Map(books.map((book) => [book.slug, book]));
  return slugs.flatMap((slug) => {
    const book = bySlug.get(slug);
    return book ? [book] : [];
  });
}

function SermonCard({ video, light, accentColor }: { video: LibraryVideo; light: boolean; accentColor: LibraryBranding["accentColor"] }) {
  return (
    <a
      href={video.youtubeUrl}
      target="_blank"
      rel="noreferrer"
      className={`group w-[78vw] max-w-[320px] shrink-0 snap-start overflow-hidden rounded-2xl border transition-colors ${light ? "border-slate-200 bg-white hover:border-slate-300" : "border-slate-800 bg-slate-900/70 hover:border-slate-700"}`}
    >
      <div className="relative aspect-video overflow-hidden bg-slate-900">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`https://i.ytimg.com/vi/${encodeURIComponent(video.videoId)}/hqdefault.jpg`}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
        />
        <span className="absolute bottom-3 left-3 rounded-full bg-black/75 px-3 py-1 text-xs font-semibold text-white">
          Watch sermon
        </span>
      </div>
      <div className="p-4">
        <h3 className={`line-clamp-2 text-base font-semibold leading-snug ${light ? "text-slate-900" : "text-slate-100"}`}>{video.title}</h3>
        <p className={`mt-2 text-xs ${ACCENT_TEXT[accentColor]}`}>
          {video.playlists.length ? video.playlists.join(" · ") : "Sermon"}
        </p>
      </div>
    </a>
  );
}

function ShortCard({ short, light, accentColor }: { short: PublicShort; light: boolean; accentColor: LibraryBranding["accentColor"] }) {
  return (
    <Link
      href={`/library/shorts/${encodeURIComponent(short.slug)}`}
      className={`group w-[48vw] max-w-[190px] shrink-0 snap-start overflow-hidden rounded-2xl border transition-colors ${light ? "border-slate-200 bg-white hover:border-slate-300" : "border-slate-800 bg-slate-900/70 hover:border-slate-700"}`}
    >
      <div className="relative aspect-[9/16] min-h-48 overflow-hidden bg-slate-900">
        {short.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={short.thumbnailUrl} alt="" loading="lazy" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" />
        ) : (
          <div className="flex h-full items-center justify-center text-4xl text-white/50" aria-hidden>▶</div>
        )}
        <span className="absolute bottom-3 left-3 rounded-full bg-black/75 px-3 py-1 text-xs font-semibold text-white">Watch short</span>
      </div>
      <div className="p-4">
        <h3 className={`line-clamp-2 text-base font-semibold leading-snug ${light ? "text-slate-900" : "text-slate-100"}`}>{short.title}</h3>
        <p className={`mt-2 text-xs ${ACCENT_TEXT[accentColor]}`}>{short.sourceType === "youtube" ? "Short teaching" : "Video short"}</p>
      </div>
    </Link>
  );
}

export default async function LibraryWelcomePage() {
  const [branding, content] = await Promise.all([
    readLibraryBranding(),
    readLibraryWelcomeContent(),
  ]);
  const light = branding.colorMode === "light";
  const books = chooseBooks(content.books, branding.featuredBookSlugs);
  const sermons = chooseSermons(content.sermons, branding.featuredSermonIds);
  const shorts = chooseShorts(content.shorts, branding.featuredShortSlugs);

  return (
    <main data-pjdl-mode={branding.colorMode} style={{ colorScheme: branding.colorMode }} className={`min-h-dvh pb-20 lg:pl-64 lg:pb-0 ${light ? "bg-slate-50 text-slate-900" : "bg-slate-950 text-slate-100"}`}>
      <LibraryNav branding={branding} />
      <header className={`sticky top-0 z-10 border-b px-5 py-4 backdrop-blur-xl ${light ? "border-slate-200 bg-white/90" : "border-slate-800/60 bg-slate-950/90"}`}>
        <div className="mx-auto max-w-6xl">
          <p className={`text-[10px] font-semibold uppercase tracking-[0.22em] ${ACCENT_TEXT[branding.accentColor]}`}>{branding.shortName}</p>
          <h1 className={`text-xl font-bold tracking-tight ${light ? "text-slate-950" : "text-slate-100"}`}>Welcome</h1>
        </div>
      </header>

      <LibraryHero branding={branding} />

      <div className="mx-auto max-w-6xl px-5">
        {branding.sections
          .filter((section) => (
            section === "featuredSermons"
            || section === "featuredShorts"
            || (section === "featuredBooks" && books.length > 0)
          ))
          .map((section) => (
            <section key={section} className="border-t border-slate-800/60 py-8 first:border-t-0 lg:py-10">
            {section === "featuredSermons" && (
              <>
                <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
                  <div className="min-w-0">
                    <p className={`text-xs font-bold uppercase tracking-[0.2em] ${ACCENT_TEXT[branding.accentColor]}`}>Featured sermons</p>
                    <h2 className={`mt-2 text-xl font-bold sm:text-2xl ${light ? "text-slate-950" : "text-white"}`}>Teaching to return to</h2>
                  </div>
                  <Link href="/library/videos" className={`flex min-h-12 shrink-0 items-center rounded-xl border px-4 text-sm font-semibold ${light ? "border-slate-300 text-slate-700" : "border-slate-700 text-slate-200"}`}>All videos</Link>
                </div>
                {sermons.length ? (
                  <div role="region" aria-label="Featured sermons" tabIndex={0} className={FEATURED_ROW_CLASS}>
                    {sermons.map((video) => <SermonCard key={video.videoId} video={video} light={light} accentColor={branding.accentColor} />)}
                  </div>
                ) : (
                  <p className={`rounded-2xl border p-5 text-sm ${light ? "border-slate-200 bg-white text-slate-600" : "border-slate-800 bg-slate-900/50 text-slate-400"}`}>No published sermons are available yet.</p>
                )}
              </>
            )}
            {section === "featuredShorts" && (
              <>
                <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
                  <div className="min-w-0">
                    <p className={`text-xs font-bold uppercase tracking-[0.2em] ${ACCENT_TEXT[branding.accentColor]}`}>Featured shorts</p>
                    <h2 className={`mt-2 text-xl font-bold sm:text-2xl ${light ? "text-slate-950" : "text-white"}`}>A moment of insight</h2>
                  </div>
                  <Link href="/library/shorts" className={`flex min-h-12 shrink-0 items-center rounded-xl border px-4 text-sm font-semibold ${light ? "border-slate-300 text-slate-700" : "border-slate-700 text-slate-200"}`}>All shorts</Link>
                </div>
                {shorts.length ? (
                  <div role="region" aria-label="Featured shorts" tabIndex={0} className={FEATURED_ROW_CLASS}>
                    {shorts.map((short) => <ShortCard key={short.slug} short={short} light={light} accentColor={branding.accentColor} />)}
                  </div>
                ) : (
                  <p className={`rounded-2xl border p-5 text-sm ${light ? "border-slate-200 bg-white text-slate-600" : "border-slate-800 bg-slate-900/50 text-slate-400"}`}>No published shorts are available yet.</p>
                )}
              </>
            )}
            {section === "featuredBooks" && (
              <>
                <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
                  <div className="min-w-0">
                    <p className={`text-xs font-bold uppercase tracking-[0.2em] ${ACCENT_TEXT[branding.accentColor]}`}>Featured books</p>
                    <h2 className={`mt-2 text-xl font-bold sm:text-2xl ${light ? "text-slate-950" : "text-white"}`}>Books selected for you</h2>
                  </div>
                  <Link href="/library/books" className={`flex min-h-12 shrink-0 items-center rounded-xl border px-4 text-sm font-semibold ${light ? "border-slate-300 text-slate-700" : "border-slate-700 text-slate-200"}`}>Browse all books</Link>
                </div>
                <div role="region" aria-label="Featured books" tabIndex={0} className={FEATURED_ROW_CLASS}>
                  {books.map((book) => (
                    <div key={book.slug} className="w-[54vw] max-w-[220px] shrink-0 snap-start">
                      <LibraryBookCard
                        book={book}
                        colorMode={branding.colorMode}
                        accentColor={branding.accentColor}
                      />
                    </div>
                  ))}
                </div>
              </>
            )}
            </section>
          ))}
      </div>
    </main>
  );
}
