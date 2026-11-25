import Link from "next/link";
import type { LibraryBranding } from "@/lib/schemas/library-branding";

const ACCENT_STYLES: Record<LibraryBranding["accentColor"], { badgeDark: string; badgeLight: string; button: string; glow: string }> = {
  amber: { badgeDark: "border-amber-400/25 text-amber-300", badgeLight: "border-amber-600/30 text-amber-800", button: "bg-amber-400 hover:bg-amber-300", glow: "from-amber-500/10" },
  cyan: { badgeDark: "border-cyan-400/25 text-cyan-300", badgeLight: "border-cyan-600/30 text-cyan-800", button: "bg-cyan-400 hover:bg-cyan-300", glow: "from-cyan-500/10" },
  emerald: { badgeDark: "border-emerald-400/25 text-emerald-300", badgeLight: "border-emerald-600/30 text-emerald-800", button: "bg-emerald-400 hover:bg-emerald-300", glow: "from-emerald-500/10" },
  rose: { badgeDark: "border-rose-400/25 text-rose-300", badgeLight: "border-rose-600/30 text-rose-800", button: "bg-rose-400 hover:bg-rose-300", glow: "from-rose-500/10" },
  violet: { badgeDark: "border-violet-400/25 text-violet-300", badgeLight: "border-violet-600/30 text-violet-800", button: "bg-violet-400 hover:bg-violet-300", glow: "from-violet-500/10" },
};

function HeroActions({ accent, light }: { accent: LibraryBranding["accentColor"]; light: boolean }) {
  return (
    <div className="mt-7 flex flex-wrap gap-3">
      <Link href="/library/ask" className={`inline-flex min-h-12 items-center justify-center rounded-xl px-5 text-base font-bold text-slate-950 transition-colors ${ACCENT_STYLES[accent].button}`}>
        Ask the library
      </Link>
      <Link href="/library/videos" className={`inline-flex min-h-12 items-center justify-center rounded-xl border px-5 text-base font-semibold transition-colors ${light ? "border-slate-300 bg-white/70 text-slate-800 hover:bg-white" : "border-white/20 bg-slate-950/40 text-white hover:bg-slate-950/70"}`}>
        Browse videos
      </Link>
      <Link href="/library/faqs" className={`inline-flex min-h-12 items-center justify-center rounded-xl border px-5 text-base font-semibold transition-colors ${light ? "border-slate-300 bg-white/70 text-slate-800 hover:bg-white" : "border-white/20 bg-slate-950/40 text-white hover:bg-slate-950/70"}`}>
        Browse FAQs
      </Link>
      <Link href="/library/books" className={`inline-flex min-h-12 items-center justify-center rounded-xl border px-5 text-base font-semibold transition-colors ${light ? "border-slate-300 bg-white/70 text-slate-800 hover:bg-white" : "border-white/20 bg-slate-950/40 text-white hover:bg-slate-950/70"}`}>
        Browse books
      </Link>
    </div>
  );
}

function BrandCopy({ branding, light }: { branding: LibraryBranding; light: boolean }) {
  return (
    <div className="max-w-3xl">
      <div className={`mb-5 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 ${light ? "bg-white/80" : "bg-slate-950/60"} ${light ? ACCENT_STYLES[branding.accentColor].badgeLight : ACCENT_STYLES[branding.accentColor].badgeDark}`}>
        <span className="text-[10px] font-black uppercase tracking-[0.2em]">{branding.shortName}</span>
        <span aria-hidden className="h-1 w-1 rounded-full bg-current opacity-70" />
        <span className={`text-[10px] font-semibold uppercase tracking-[0.14em] ${light ? "text-slate-600" : "text-slate-300"}`}>{branding.tagline}</span>
      </div>
      <h2 className={`max-w-2xl text-4xl font-bold leading-[1.05] tracking-tight sm:text-5xl lg:text-6xl ${light ? "text-slate-950" : "text-white"}`}>
        {branding.title}
      </h2>
      <p className={`mt-4 max-w-xl text-sm leading-relaxed sm:text-base ${light ? "text-slate-700" : "text-slate-300"}`}>
        {branding.description}
      </p>
      <HeroActions accent={branding.accentColor} light={light} />
    </div>
  );
}

export default function LibraryHero({ branding }: { branding: LibraryBranding }) {
  const light = branding.colorMode === "light";
  const baseClass = light
    ? "border-slate-200 bg-white shadow-slate-900/10"
    : "border-white/10 bg-slate-900 shadow-black/30";
  const image = branding.coverImageUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={branding.coverImageUrl} alt="" className="h-full w-full object-cover" />
  ) : null;

  if (branding.heroLayout === "split") {
    return (
      <section className="mx-auto max-w-6xl px-5 pb-8 pt-6 sm:pt-8 lg:pb-10">
        <div className={`grid overflow-hidden rounded-3xl border shadow-2xl lg:grid-cols-[minmax(0,1.1fr)_minmax(280px,0.9fr)] ${baseClass}`}>
          <div className="flex min-h-[340px] items-center p-5 sm:p-8 lg:p-12">
            <BrandCopy branding={branding} light={light} />
          </div>
          <div className={`relative min-h-56 overflow-hidden lg:min-h-[420px] ${light ? "bg-slate-100" : "bg-slate-950"}`}>
            {image ? (
              <div className="absolute inset-0">{image}</div>
            ) : (
              <div className={`absolute inset-0 bg-gradient-to-br ${ACCENT_STYLES[branding.accentColor].glow} to-transparent`} />
            )}
            <div className={`absolute inset-0 ${light ? "bg-gradient-to-t from-white/20 to-transparent" : "bg-gradient-to-t from-slate-950/30 to-transparent"}`} />
          </div>
        </div>
      </section>
    );
  }

  if (branding.heroLayout === "simple") {
    if (branding.simpleCoverLayer === "foreground") {
      return (
        <section className="mx-auto max-w-6xl px-5 pb-8 pt-6 sm:pt-8 lg:pb-10">
          <div className={`relative isolate overflow-hidden rounded-3xl border shadow-xl ${baseClass}`}>
            <div className={`absolute inset-0 z-0 bg-gradient-to-r ${ACCENT_STYLES[branding.accentColor].glow} to-transparent`} />
            <div className="relative z-10 grid gap-6 p-5 sm:p-8 lg:grid-cols-[minmax(0,1.3fr)_minmax(240px,0.7fr)] lg:items-center lg:gap-10 lg:p-10">
              <BrandCopy branding={branding} light={light} />
              <div className={`relative min-h-56 overflow-hidden rounded-2xl border ${light ? "border-slate-200 bg-slate-100" : "border-white/10 bg-slate-950"} sm:min-h-72 lg:min-h-80`}>
                {image ? (
                  <div className="absolute inset-0">{image}</div>
                ) : (
                  <div className={`absolute inset-0 bg-gradient-to-br ${ACCENT_STYLES[branding.accentColor].glow} to-transparent`} />
                )}
              </div>
            </div>
          </div>
        </section>
      );
    }

    return (
      <section className="mx-auto max-w-6xl px-5 pb-8 pt-6 sm:pt-8 lg:pb-10">
        <div className={`relative isolate overflow-hidden rounded-3xl border shadow-xl ${baseClass}`}>
          {image && (
            <div aria-hidden className="absolute inset-y-0 right-0 hidden w-1/3 overflow-hidden opacity-20 sm:block">{image}</div>
          )}
          <div className={`absolute inset-0 z-0 bg-gradient-to-r ${ACCENT_STYLES[branding.accentColor].glow} to-transparent`} />
          <div className="relative z-10 p-5 sm:p-8 lg:p-10">
            <BrandCopy branding={branding} light={light} />
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-6xl px-5 pb-8 pt-6 sm:pt-8 lg:pb-10">
      <div className={`relative isolate overflow-hidden rounded-3xl border shadow-2xl ${baseClass}`}>
        <div aria-hidden className="pointer-events-none absolute inset-0">
          {image && (
            <>
              <div className="absolute inset-0 opacity-45">{image}</div>
              <div className={`absolute inset-0 ${light ? "bg-gradient-to-r from-white via-white/85 to-white/40" : "bg-gradient-to-r from-slate-950 via-slate-950/85 to-slate-950/45"}`} />
            </>
          )}
          <div className={`absolute inset-0 bg-gradient-to-br ${ACCENT_STYLES[branding.accentColor].glow} via-transparent to-cyan-500/10`} />
          <div className={`absolute inset-0 ${light ? "bg-gradient-to-t from-white/70 via-transparent to-white/10" : "bg-gradient-to-t from-slate-950/80 via-transparent to-slate-950/10"}`} />
        </div>
        <div className="relative flex min-h-[400px] items-center p-5 sm:p-8 lg:min-h-[420px] lg:p-12">
          <BrandCopy branding={branding} light={light} />
        </div>
      </div>
    </section>
  );
}
