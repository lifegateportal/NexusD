"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { NexusNav } from "@/app/components/NexusNav";
import {
  LibraryTrafficSummarySchema,
  type LibraryTrafficSummary,
} from "@/lib/schemas/library-analytics";

const RANGES = [7, 30, 90] as const;
type Range = typeof RANGES[number];

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatDate(value: string): string {
  return new Date(`${value}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function TrafficList({
  title,
  items,
  emptyText,
}: {
  title: string;
  items: Array<{ label: string; pageViews: number }>;
  emptyText: string;
}) {
  const maximum = Math.max(1, ...items.map((item) => item.pageViews));
  return (
    <section className="min-w-0 rounded-2xl border border-slate-800 bg-slate-900/60 p-4 sm:p-5">
      <h2 className="text-base font-bold text-white">{title}</h2>
      {items.length ? (
        <ol className="mt-4 space-y-4">
          {items.map((item) => (
            <li key={item.label} className="min-w-0">
              <div className="flex min-w-0 items-center justify-between gap-3 text-sm">
                <span className="min-w-0 break-all text-slate-300">{item.label}</span>
                <span className="shrink-0 font-semibold tabular-nums text-slate-100">{formatNumber(item.pageViews)}</span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-800" aria-hidden="true">
                <div
                  className="h-full rounded-full bg-cyan-400"
                  style={{ width: `${Math.max(3, (item.pageViews / maximum) * 100)}%` }}
                />
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-4 text-sm text-slate-400">{emptyText}</p>
      )}
    </section>
  );
}

export default function LibraryTrafficDashboard() {
  const router = useRouter();
  const [range, setRange] = useState<Range>(30);
  const [summary, setSummary] = useState<LibraryTrafficSummary | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const loadSummary = useCallback(async (days: Range, signal: AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/ebook/library-analytics?days=${days}`, {
        cache: "no-store",
        signal,
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        const errorMessage = typeof body === "object" && body !== null && "error" in body
          && typeof body.error === "string"
          ? body.error
          : `Could not load analytics (HTTP ${response.status}).`;
        throw new Error(errorMessage);
      }
      const parsed = LibraryTrafficSummarySchema.safeParse(body);
      if (!parsed.success) throw new Error("The traffic report returned an invalid format.");
      setSummary(parsed.data);
    } catch (loadError: unknown) {
      if (loadError instanceof DOMException && loadError.name === "AbortError") return;
      setError(loadError instanceof Error ? loadError.message : "Could not load library traffic.");
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadSummary(range, controller.signal);
    return () => controller.abort();
  }, [loadSummary, range]);

  const handleNavSelect = useCallback((id: string) => {
    router.push(id === "library" ? "/ebook/library" : id === "ebook" ? "/ebook?tab=pipeline" : "/");
  }, [router]);
  const maxDailyViews = Math.max(1, ...(summary?.byDay.map((day) => day.pageViews) ?? []));

  return (
    <div className="flex h-dvh max-h-dvh overflow-hidden bg-shell-950 bg-grid bg-radial-glow safe-area-frame text-slate-100">
      <NexusNav active="library" onSelect={handleNavSelect} />
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-20 pt-5 sm:px-6 lg:pb-6 lg:pt-8">
        <div className="mx-auto max-w-6xl">
          <header className="mb-6 border-b border-slate-800 pb-5">
            <Link href="/ebook/library" className="inline-flex min-h-12 items-center text-sm font-semibold text-cyan-300">
              ← Library Studio
            </Link>
            <div className="mt-3 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-cyan-300">Public PJDL</p>
                <h1 className="mt-2 text-3xl font-bold tracking-tight text-white sm:text-4xl">Library traffic</h1>
                <p className="mt-2 text-sm text-slate-400">Anonymous page views, estimated sessions, and traffic sources.</p>
              </div>
              <div className="flex flex-wrap gap-2" role="group" aria-label="Report date range">
                {RANGES.map((days) => (
                  <button
                    key={days}
                    type="button"
                    aria-pressed={range === days}
                    onClick={() => setRange(days)}
                    className={`min-h-12 min-w-16 rounded-xl border px-3 text-sm font-semibold ${
                      range === days
                        ? "border-cyan-400 bg-cyan-500/15 text-cyan-100"
                        : "border-slate-700 bg-slate-900/70 text-slate-300"
                    }`}
                  >
                    {days} days
                  </button>
                ))}
              </div>
            </div>
          </header>

          {error && (
            <p role="alert" className="mb-5 rounded-xl border border-rose-700/50 bg-rose-950/40 p-4 text-sm text-rose-200">
              {error}
            </p>
          )}

          {loading && !summary ? (
            <p className="py-12 text-center text-sm text-slate-400">Loading library traffic…</p>
          ) : summary ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
                  <p className="text-sm text-slate-400">Page views</p>
                  <p className="mt-2 text-3xl font-bold tabular-nums text-white">{formatNumber(summary.pageViews)}</p>
                  <p className="mt-1 text-xs text-slate-500">Recorded in the selected period</p>
                </section>
                <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
                  <p className="text-sm text-slate-400">Estimated sessions</p>
                  <p className="mt-2 text-3xl font-bold tabular-nums text-white">{formatNumber(summary.sessions)}</p>
                  <p className="mt-1 text-xs text-slate-500">Browser sessions, not identified people</p>
                </section>
              </div>

              <section className="mt-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-4 sm:p-5">
                <h2 className="text-base font-bold text-white">Daily page views</h2>
                <ol className="mt-4 space-y-3">
                  {[...summary.byDay].reverse().map((day) => (
                    <li key={day.date} className="grid grid-cols-[4.5rem_minmax(0,1fr)_3rem] items-center gap-3 text-xs sm:grid-cols-[6rem_minmax(0,1fr)_4rem] sm:text-sm">
                      <time dateTime={day.date} className="text-slate-400">{formatDate(day.date)}</time>
                      <div className="h-3 overflow-hidden rounded-full bg-slate-800">
                        <div
                          className="h-full rounded-full bg-cyan-400"
                          style={{ width: `${day.pageViews ? Math.max(2, (day.pageViews / maxDailyViews) * 100) : 0}%` }}
                        />
                      </div>
                      <span className="text-right tabular-nums text-slate-200">{formatNumber(day.pageViews)}</span>
                    </li>
                  ))}
                </ol>
              </section>

              <div className="mt-4 grid gap-4 lg:grid-cols-3">
                <TrafficList title="Top pages" items={summary.topPages} emptyText="No page views recorded yet." />
                <TrafficList title="Traffic sources" items={summary.topSources} emptyText="No traffic sources recorded yet." />
                <TrafficList title="Devices" items={summary.devices} emptyText="No device data recorded yet." />
              </div>
            </>
          ) : null}

          <p className="mt-5 pb-4 text-xs leading-relaxed text-slate-500">
            Analytics records page path, referring site, device category, and a session-only anonymous identifier. It does not store names or IP addresses. Visitors who enable Do Not Track are not counted; estimates may also miss visitors who block scripts.
          </p>
        </div>
      </main>
    </div>
  );
}
