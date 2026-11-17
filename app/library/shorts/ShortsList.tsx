"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { z } from "zod";
import { PublicShortCatalogSchema } from "@/lib/schemas/video-short";

const ErrorSchema = z.object({ error: z.string() });
type Short = z.infer<typeof PublicShortCatalogSchema>["shorts"][number];

export default function ShortsList() {
  const [shorts, setShorts] = useState<Short[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    fetch("/api/library/shorts", { cache: "no-store" })
      .then(async (response) => {
        const body: unknown = await response.json();
        if (!response.ok) {
          const parsed = ErrorSchema.safeParse(body);
          throw new Error(parsed.success ? parsed.data.error : `Could not load shorts (HTTP ${response.status}).`);
        }
        const parsed = PublicShortCatalogSchema.safeParse(body);
        if (!parsed.success) throw new Error("The published shorts catalog has an invalid format.");
        if (active) setShorts(parsed.data.shorts);
      })
      .catch((loadError: unknown) => {
        if (active) setError(loadError instanceof Error ? loadError.message : "Could not load published shorts.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  return (
    <div className="space-y-6">
      <header className="border-b border-slate-800 pb-6">
        <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-amber-400">Nexus Library</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-white">Video Shorts</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-400">
          Short clips with transcript-synced captions, published from Nexus Director.
        </p>
      </header>
      {error && <p role="alert" className="rounded-xl border border-rose-900 bg-rose-950/40 p-4 text-sm text-rose-200">{error}</p>}
      {loading ? (
        <p className="py-12 text-center text-sm text-slate-400">Loading published shorts…</p>
      ) : shorts.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-slate-700 p-10 text-center text-sm text-slate-400">
          No shorts have been published yet.
        </p>
      ) : (
        <ul className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {shorts.map((short) => (
            <li key={short.slug} className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
              <h2 className="font-semibold leading-snug text-white">{short.title}</h2>
              {short.videoTitle && <p className="mt-2 text-xs text-slate-400">From: {short.videoTitle}</p>}
              <Link
                href={`/library/shorts/${short.slug}`}
                className="mt-3 flex min-h-12 items-center justify-center rounded-xl bg-cyan-400 px-4 text-sm font-bold text-slate-950"
              >
                Watch short
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
