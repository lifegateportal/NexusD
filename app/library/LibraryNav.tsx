import Link from "next/link";

const links = [
  { href: "/library", label: "Books", icon: "▤" },
  { href: "/library/ask", label: "Ask the library", icon: "✳" },
  { href: "/library/faqs", label: "FAQs", icon: "?" },
  { href: "/library/videos", label: "Videos", icon: "▷" },
  { href: "/library/shorts", label: "Shorts", icon: "▸" },
];

export default function LibraryNav() {
  return (
    <>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-slate-800/70 bg-slate-950 px-5 py-8 lg:flex">
        <Link href="/library" className="mb-10 block">
          <span className="text-[10px] font-bold uppercase tracking-[0.3em] text-amber-400">Nexus</span>
          <span className="mt-1 block text-xl font-bold text-white">Library</span>
        </Link>
        <nav aria-label="Library" className="space-y-2">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="flex min-h-12 items-center gap-3 rounded-xl px-3 text-sm font-medium text-slate-400 transition hover:bg-slate-900 hover:text-white"
            >
              <span aria-hidden className="w-6 text-center text-lg text-amber-400">{link.icon}</span>
              {link.label}
            </Link>
          ))}
        </nav>
        <p className="mt-auto text-xs leading-relaxed text-slate-600">
          Explore the books. Ask questions grounded in the author's words.
        </p>
      </aside>

      <nav
        aria-label="Library"
        className="fixed inset-x-0 bottom-0 z-30 flex min-h-16 items-stretch justify-start overflow-x-auto border-t border-slate-800/80 bg-slate-950/95 px-2 pb-[max(env(safe-area-inset-bottom),_0.25rem)] backdrop-blur-xl [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:hidden"
      >
        {links.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="flex min-h-12 min-w-20 flex-none flex-col items-center justify-center gap-0.5 px-2 text-[10px] font-semibold text-slate-400"
          >
            <span aria-hidden className="text-lg leading-5 text-amber-400">{link.icon}</span>
            <span>{link.label}</span>
          </Link>
        ))}
      </nav>
    </>
  );
}
