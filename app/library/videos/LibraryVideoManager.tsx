"use client";

import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { LibraryVideoCatalogSchema } from "@/lib/schemas/library-video";

type Video = z.infer<typeof LibraryVideoCatalogSchema>["videos"][number];
const ErrorSchema = z.object({ error: z.string() });

export default function LibraryVideoManager() {
  const [videos, setVideos] = useState<Video[]>([]);
  const [activeVideoId, setActiveVideoId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    fetch("/api/library/videos", { cache: "no-store" })
      .then(async (response) => {
        const body: unknown = await response.json();
        if (!response.ok) {
          const parsed = ErrorSchema.safeParse(body);
          throw new Error(parsed.success ? parsed.data.error : `Could not load videos (HTTP ${response.status}).`);
        }
        const parsed = LibraryVideoCatalogSchema.safeParse(body);
        if (!parsed.success) throw new Error("The video catalog has an invalid format.");
        if (active) setVideos(parsed.data.videos);
      })
      .catch((loadError: unknown) => {
        if (active) setError(loadError instanceof Error ? loadError.message : "Could not load videos.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  const filteredVideos = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return videos.filter((video) => !needle || video.title.toLocaleLowerCase().includes(needle));
  }, [query, videos]);

  return (
    <div className="space-y-6 pb-20 lg:pb-0">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-cyan-300">Watch · Listen · Learn</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-white sm:text-4xl">Video Library</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-400">
            Watch approved Lifegate Broadcast videos, or ask the Library to find a specific answer in their transcripts.
          </p>
        </div>
        <label className="w-full sm:max-w-xs">
          <span className="sr-only">Search videos</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search videos…"
            className="min-h-12 w-full rounded-xl border border-slate-700 bg-slate-900 px-4 text-base text-white placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none"
          />
        </label>
      </header>

      {error && <p role="alert" className="rounded-xl border border-rose-900 bg-rose-950/40 p-4 text-sm text-rose-200">{error}</p>}
      {loading ? (
        <p className="py-12 text-center text-sm text-slate-400">Loading the approved video library…</p>
      ) : filteredVideos.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-slate-700 p-10 text-center text-sm text-slate-400">
          {videos.length ? "No videos match that search." : "No videos have been published yet."}
        </p>
      ) : (
        <ul className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {filteredVideos.map((video) => {
            const isPlaying = activeVideoId === video.videoId;
            return (
              <li key={video.videoId} className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/50">
                <div className="aspect-video bg-slate-950">
                  {isPlaying ? (
                    <iframe
                      className="h-full w-full"
                      src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(video.videoId)}?autoplay=1&rel=0`}
                      title={video.title}
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                      referrerPolicy="strict-origin-when-cross-origin"
                      allowFullScreen
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => setActiveVideoId(video.videoId)}
                      className="group relative flex h-full w-full items-center justify-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300"
                      aria-label={`Play ${video.title}`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg`}
                        alt=""
                        loading="lazy"
                        className="absolute inset-0 h-full w-full object-cover opacity-80"
                      />
                      <span className="relative flex min-h-12 items-center gap-2 rounded-full bg-slate-950/90 px-5 text-sm font-bold text-white">
                        <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 fill-current"><path d="M8 5v14l11-7z" /></svg>
                        Play video
                      </span>
                    </button>
                  )}
                </div>
                <div className="p-4">
                  <h2 className="font-semibold leading-snug text-white">{video.title}</h2>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs text-slate-500">Approved for watching and transcript search</span>
                    <a
                      href={video.youtubeUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="flex min-h-12 items-center rounded-lg px-3 text-xs font-semibold text-cyan-300"
                    >
                      Open on YouTube
                    </a>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
