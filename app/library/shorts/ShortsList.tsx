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
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 xl:grid-cols-4">
          {shorts.map((short) => (
            <li key={short.slug}>
              <Link
                href={`/library/shorts/${short.slug}`}
                className="relative block aspect-[9/16] min-h-48 overflow-hidden rounded-xl border border-slate-800 bg-gradient-to-br from-slate-800 via-slate-900 to-cyan-950"
              >
                {short.thumbnailUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={short.thumbnailUrl}
                    alt=""
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                )}
                <span className="absolute left-1/2 top-1/2 flex h-12 min-w-12 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/70 px-3 text-xs font-bold text-white">
                  Play
                </span>
                <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 via-black/60 to-transparent p-3 pt-16">
                  <span className="line-clamp-2 block text-sm font-bold leading-snug text-white sm:text-base">
                    {short.title}
                  </span>
                  {short.videoTitle && (
                    <span className="mt-1 line-clamp-1 block text-[11px] text-slate-200 sm:text-xs">
                      From: {short.videoTitle}
                    </span>
                  )}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
