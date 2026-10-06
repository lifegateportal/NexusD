"use client";

import { useCallback, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

type NavItem = { id: string; label: string; href?: string };

const NAV_ITEMS: NavItem[] = [
  { id: "overview", label: "Academy" },
  { id: "ebook", label: "Book" },
  { id: "translate", label: "Translate", href: "/translate" },
  { id: "projects", label: "Projects" },
  { id: "sermon", label: "Sermon" },
];

/** Overview — mission control hub */
function IconGrid() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-5 w-5">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

/** Ebook — audio to ebook production */
function IconEbook() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-5 w-5">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9 7h7M9 11h5" strokeLinecap="round" />
    </svg>
  );
}

/** Projects — saved workspace archive */
function IconProjects() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-5 w-5">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="12" y1="11" x2="12" y2="17" strokeLinecap="round" />
      <line x1="9" y1="14" x2="15" y2="14" strokeLinecap="round" />
    </svg>
  );
}

/** Translate — standalone translation pipeline */
function IconTranslate() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-5 w-5">
      <path d="M4 5h8" strokeLinecap="round" />
      <path d="M4 10h5" strokeLinecap="round" />
      <path d="m7 5 2 5 2-5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="m14 8 3-4 3 4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14 18h6" strokeLinecap="round" />
      <path d="m16.5 11 0 7" strokeLinecap="round" />
    </svg>
  );
}

/** Sermon — live sermon restructuring assistant */
function IconSermon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-5 w-5">
      <path d="M12 4a3 3 0 0 1 3 3v5a3 3 0 1 1-6 0V7a3 3 0 0 1 3-3Z" />
      <path d="M6 11a6 6 0 0 0 12 0" strokeLinecap="round" />
      <path d="M12 17v3" strokeLinecap="round" />
      <path d="M9 20h6" strokeLinecap="round" />
    </svg>
  );
}

const NAV_ICONS: Record<string, () => React.JSX.Element> = {
  overview: IconGrid,
  ebook: IconEbook,
  translate: IconTranslate,
  projects: IconProjects,
  sermon: IconSermon,
};

type NexusNavProps = {
  active: string;
  onSelect: (id: string) => void;
};

function IconLogout() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-5 w-5">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" strokeLinecap="round" strokeLinejoin="round" />
      <polyline points="16 17 21 12 16 7" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="21" y1="12" x2="9" y2="12" strokeLinecap="round" />
    </svg>
  );
}

export function NexusNav({ active, onSelect }: NexusNavProps) {
  const pathname = usePathname();
  const router = useRouter();

  const navigateTo = useCallback((href: string) => {
    // Skip redundant pushes to avoid unnecessary route remounts.
    if (href === "/translate" && pathname.startsWith("/translate")) return;
    if (href.startsWith("/ebook") && pathname.startsWith("/ebook")) return;
    if (href === "/" && pathname === "/") return;
    router.push(href);
  }, [pathname, router]);

  useEffect(() => {
    router.prefetch("/");
    router.prefetch("/ebook?tab=pipeline");
    router.prefetch("/translate");
  }, [router]);

  const handleLogout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  }, [router]);

  const LogoMark = () => (
    <div
      className="flex h-10 w-10 items-center justify-center rounded-xl bg-cyan-500/20 ring-1 ring-cyan-400/50"
      style={{ boxShadow: "0 0 18px rgba(6,182,212,0.30)" }}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-5 w-5 text-cyan-400">
        <path d="M12 2 21 6.5V17L12 21.5 3 17V6.5L12 2z" strokeLinejoin="round" />
        <path d="M12 2v19.5M3 6.5l9 5 9-5" strokeLinejoin="round" />
      </svg>
    </div>
  );

  return (
    <>
      {/* ── Desktop sidebar (lg+) ─────────────────────────────── */}
      <nav
        className="hidden lg:flex h-full w-[72px] flex-shrink-0 flex-col items-center gap-1 border-r border-cyan-500/15 py-4 glass"
        aria-label="Nexus Director navigation"
      >
        <div className="mb-4"><LogoMark /></div>

        <div className="flex flex-col gap-1">
          {NAV_ITEMS.map((item) => {
            const Icon = NAV_ICONS[item.id] ?? IconGrid;
            const isAcademyGroup = item.id === "overview";
            const isActive = item.href
              ? pathname.startsWith(item.href)
              : isAcademyGroup
                ? active !== "ebook" && active !== "sermon" && active !== "projects"
                  && active !== "translate"
                : active === item.id;
            const btnClass = [
              "focus-ring relative flex min-h-12 w-12 items-center justify-center rounded-xl transition-all duration-150",
              isActive
                ? "bg-gradient-to-br from-cyan-500/25 to-violet-500/15 text-cyan-300 ring-1 ring-cyan-400/40"
                : "text-slate-500 hover:bg-slate-700/40 hover:text-slate-200 active:bg-slate-700/60"
            ].join(" ");
            const indicator = isActive ? (
              <span
                className="absolute left-0 top-1/2 h-6 w-0.5 -translate-y-1/2 rounded-r-full bg-cyan-400"
                style={{ boxShadow: "0 0 6px rgba(6,182,212,0.80)" }}
              />
            ) : null;
            const href = item.href;
            if (href) {
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => navigateTo(href)}
                  aria-label={item.label}
                  aria-current={isActive ? "page" : undefined}
                  className={btnClass}
                  style={isActive ? { boxShadow: "0 0 12px rgba(6,182,212,0.20)" } : undefined}
                >
                  {indicator}
                  <Icon />
                </button>
              );
            }
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelect(item.id)}
                aria-label={item.label}
                aria-current={isActive ? "page" : undefined}
                className={btnClass}
                style={isActive ? { boxShadow: "0 0 12px rgba(6,182,212,0.20)" } : undefined}
              >
                {indicator}
                <Icon />
              </button>
            );
          })}
        </div>

        <div className="flex-1" />
        <button
          type="button"
          onClick={handleLogout}
          aria-label="Log out"
          title="Log out"
          className="focus-ring flex min-h-12 w-12 items-center justify-center rounded-xl text-slate-600 hover:bg-rose-500/10 hover:text-rose-400 active:bg-rose-500/15 transition-all duration-150"
        >
          <IconLogout />
        </button>
        <div
          className="mb-2 h-2 w-2 rounded-full bg-emerald-400"
          style={{ boxShadow: "0 0 10px rgba(52,211,153,0.85)" }}
          title="System healthy"
        />
      </nav>

      {/* ── Mobile bottom bar (<lg) ───────────────────────────── */}
      <nav
        className="lg:hidden fixed bottom-0 left-0 right-0 z-50 flex items-stretch justify-around border-t border-cyan-500/20 glass-light select-none"
        style={{ paddingBottom: "max(env(safe-area-inset-bottom), 6px)" }}
        aria-label="Nexus Director navigation"
      >
        {/* Logo tap — goes to overview */}
        <button
          type="button"
          onClick={() => onSelect("overview")}
          aria-label="Overview"
          className="flex min-h-[52px] min-w-[48px] touch-manipulation flex-col items-center justify-center gap-0.5 px-1 pt-2 active:bg-slate-800/40"
          style={{ touchAction: "manipulation" }}
        >
          <LogoMark />
        </button>

        {/* Logout — far right of mobile bar */}
        <button
          type="button"
          onClick={() => void handleLogout()}
          aria-label="Log out"
          className="relative flex min-h-[52px] min-w-[48px] touch-manipulation flex-col items-center justify-center gap-0.5 px-1 pt-2 text-slate-600 hover:text-rose-400 active:bg-slate-800/40"
          style={{ touchAction: "manipulation" }}
        >
          <IconLogout />
          <span className="text-[9px] font-medium">Logout</span>
        </button>

        {NAV_ITEMS.map((item) => {
          const Icon = NAV_ICONS[item.id] ?? IconGrid;
          const isAcademyGroup = item.id === "overview";
          const isActive = item.href
            ? pathname.startsWith(item.href)
            : isAcademyGroup
              ? active !== "ebook" && active !== "sermon" && active !== "projects"
                && active !== "translate"
              : active === item.id;
          const inner = (
            <>
              <span className={`${isActive ? "text-cyan-400" : "text-slate-500"}`}>
                <Icon />
              </span>
              <span className={`text-[9px] font-medium ${isActive ? "text-cyan-400" : "text-slate-600"}`}>
                {item.label}
              </span>
              <span
                className={`absolute top-0 h-0.5 w-10 rounded-full bg-cyan-400 ${
                  isActive ? "opacity-100" : "opacity-0"
                }`}
                style={{ boxShadow: isActive ? "0 0 6px rgba(6,182,212,0.80)" : undefined }}
              />
            </>
          );
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                if (item.href) navigateTo(item.href);
                else onSelect(item.id);
              }}
              aria-label={item.label}
              aria-current={isActive ? "page" : undefined}
              className="relative flex min-h-[52px] min-w-[48px] touch-manipulation flex-col items-center justify-center gap-0.5 px-1 pt-2 active:bg-slate-800/40"
              style={{ touchAction: "manipulation" }}
            >
              {inner}
            </button>
          );
        })}
      </nav>
    </>
  );
}
