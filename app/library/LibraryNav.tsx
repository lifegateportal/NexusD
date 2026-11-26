import Link from "next/link";
import type { LibraryBranding } from "@/lib/schemas/library-branding";
import { readLibraryBranding } from "@/lib/library-branding-store";

const links = [
  { href: "/library", label: "Welcome", icon: "⌂" },
  { href: "/library/books", label: "Books", icon: "▤" },
  { href: "/library/ask", label: "Ask the library", icon: "✳" },
  { href: "/library/faqs", label: "FAQs", icon: "?" },
  { href: "/library/videos", label: "Videos", icon: "▷" },
  { href: "/library/shorts", label: "Shorts", icon: "▸" },
  { href: "/library/trailers", label: "Trailers", icon: "▶" },
];

const ACCENT_ICON: Record<LibraryBranding["accentColor"], string> = {
  amber: "text-amber-500",
  cyan: "text-cyan-500",
  emerald: "text-emerald-500",
  rose: "text-rose-500",
  violet: "text-violet-500",
};

export default async function LibraryNav({
  branding: providedBranding,
}: {
  branding?: Pick<LibraryBranding, "title" | "shortName" | "colorMode" | "accentColor" | "askLibraryEnabled">;
}) {
  const branding = providedBranding ?? await readLibraryBranding();
  const light = branding?.colorMode === "light";
  const title = branding?.title ?? "Pastor Josh Digital Library";
  const shortName = branding?.shortName ?? "PJDL";
  const accent = branding ? ACCENT_ICON[branding.accentColor] : "text-amber-400";
  const asideTheme = light ? "border-slate-200 bg-white" : "border-slate-800/70 bg-slate-950";
  const navText = light ? "text-slate-600 hover:bg-slate-100 hover:text-slate-950" : "text-slate-400 hover:bg-slate-900 hover:text-white";
  const mobileTheme = light ? "border-slate-200 bg-white/95" : "border-slate-800/80 bg-slate-950/95";
  const visibleLinks = links.filter((link) => (
    link.href !== "/library/ask" || branding.askLibraryEnabled
  ));

  return (
    <>
      <aside className={`fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r px-5 py-8 lg:flex ${asideTheme}`}>
        <Link href="/library" className="mb-10 block">
          <span className={`text-[10px] font-bold uppercase tracking-[0.3em] ${accent}`}>{shortName}</span>
          <span className={`mt-1 block text-xl font-bold leading-tight ${light ? "text-slate-950" : "text-white"}`}>{title}</span>
        </Link>
        <nav aria-label="Pastor Josh Digital Library navigation" className="space-y-2">
          {visibleLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`flex min-h-12 items-center gap-3 rounded-xl px-3 text-sm font-medium transition ${navText}`}
            >
              <span aria-hidden className={`w-6 text-center text-lg ${accent}`}>{link.icon}</span>
              {link.label}
            </Link>
          ))}
        </nav>
        <p className={`mt-auto text-xs leading-relaxed ${light ? "text-slate-500" : "text-slate-600"}`}>
          Explore the books. Ask questions grounded in the author's words.
        </p>
      </aside>

      <nav
        aria-label="Pastor Josh Digital Library navigation"
        className={`fixed inset-x-0 bottom-0 z-30 flex min-h-16 items-stretch justify-start overflow-x-auto border-t px-2 pb-[max(env(safe-area-inset-bottom),_0.25rem)] backdrop-blur-xl [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:hidden ${mobileTheme}`}
      >
        {visibleLinks.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className={`flex min-h-12 min-w-20 flex-none flex-col items-center justify-center gap-0.5 px-2 text-[10px] font-semibold ${light ? "text-slate-600" : "text-slate-400"}`}
          >
            <span aria-hidden className={`text-lg leading-5 ${accent}`}>{link.icon}</span>
            <span>{link.label}</span>
          </Link>
        ))}
      </nav>
    </>
  );
}
