"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { PublicShortCatalogSchema, ShortProjectSchema } from "@/lib/schemas/video-short";
import { getShortThumbnailUrl } from "@/lib/short-video-utils";

const ErrorSchema = z.object({ error: z.string() });
type Short = z.infer<typeof PublicShortCatalogSchema>["shorts"][number];

function ShortCard({ short }: { short: Short }) {
  const cardRef = useRef<HTMLAnchorElement>(null);
  const [thumbnailUrl, setThumbnailUrl] = useState(short.thumbnailUrl);
  const [thumbnailError, setThumbnailError] = useState("");

  useEffect(() => {
    if (thumbnailUrl || thumbnailError || short.sourceType !== "youtube") return;
    const card = cardRef.current;
    if (!card) return;
    let active = true;
    let observer: IntersectionObserver | null = null;
    const loadThumbnail = async () => {
      try {
        const response = await fetch(`/api/library/shorts/${encodeURIComponent(short.slug)}`);
        if (!response.ok) throw new Error(`Thumbnail request failed (HTTP ${response.status}).`);
        const body: unknown = await response.json();
        const parsed = ShortProjectSchema.safeParse(body);
        if (!parsed.success) throw new Error("The published short has an invalid format.");
        const thumbnail = getShortThumbnailUrl(parsed.data);
        if (active && thumbnail) setThumbnailUrl(thumbnail);
        else if (active) setThumbnailError("No thumbnail is available for this short.");
      } catch (error: unknown) {
        if (active) {
          setThumbnailError(error instanceof Error ? error.message : "Could not load this thumbnail.");
        }
      }
    };

    if (typeof IntersectionObserver === "undefined") {
      void loadThumbnail();
    } else {
      observer = new IntersectionObserver((entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer?.disconnect();
        void loadThumbnail();
      }, { rootMargin: "300px" });
      observer.observe(card);
    }

    return () => {
      active = false;
      observer?.disconnect();
    };
  }, [short.slug, short.sourceType, thumbnailError, thumbnailUrl]);

  return (
    <Link
      ref={cardRef}
      href={`/library/shorts/${short.slug}`}
      className="relative block aspect-[9/16] min-h-48 overflow-hidden rounded-xl border border-slate-800 bg-gradient-to-br from-slate-800 via-slate-900 to-cyan-950"
    >
      {thumbnailUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={thumbnailUrl}
          alt=""
          onError={() => {
            setThumbnailError("The thumbnail image could not be loaded.");
            setThumbnailUrl(undefined);
          }}
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
      {!thumbnailUrl && thumbnailError && (
        <span role="status" className="absolute inset-x-2 top-2 line-clamp-3 rounded bg-black/70 p-2 text-center text-xs text-slate-200">
          Thumbnail unavailable: {thumbnailError}
        </span>
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
  );
}

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
              <ShortCard short={short} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
