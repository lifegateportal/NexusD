"use client";

import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { z } from "zod";
import { DirectorVideoCatalogSchema } from "@/lib/schemas/library-video";

const ErrorSchema = z.object({ error: z.string() });
type Catalog = z.infer<typeof DirectorVideoCatalogSchema>;
type Video = Catalog["videos"][number];
type Action = "save-transcript" | "approve" | "unpublish" | "delete";

async function responseError(response: Response, body: unknown): Promise<Error> {
  const parsed = ErrorSchema.safeParse(body);
  return new Error(parsed.success ? parsed.data.error : `Request failed (HTTP ${response.status}).`);
}

export default function DirectorVideos() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [discovering, setDiscovering] = useState(false);
  const [busyVideoId, setBusyVideoId] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [videoTitle, setVideoTitle] = useState("");
  const [newTranscript, setNewTranscript] = useState("");
  const [transcriptDrafts, setTranscriptDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadCatalog = useCallback(async () => {
    const response = await fetch("/api/ebook/videos", { cache: "no-store" });
    const body: unknown = await response.json();
    if (!response.ok) throw await responseError(response, body);
    const parsed = DirectorVideoCatalogSchema.safeParse(body);
    if (!parsed.success) throw new Error("Nexus Director returned an invalid video catalog.");
    setCatalog(parsed.data);
  }, []);

  useEffect(() => {
    loadCatalog()
      .catch((loadError: unknown) => setError(loadError instanceof Error ? loadError.message : "Could not load videos."))
      .finally(() => setLoading(false));
  }, [loadCatalog]);

  async function discoverVideos() {
    setDiscovering(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/ebook/videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "discover" }),
      });
      const body: unknown = await response.json();
      if (!response.ok) throw await responseError(response, body);
      const parsed = z.object({
        catalog: DirectorVideoCatalogSchema,
        discoveredCount: z.number().int().nonnegative(),
        channelTitle: z.string(),
      }).safeParse(body);
      if (!parsed.success) throw new Error("Video discovery returned an invalid catalog.");
      setCatalog(parsed.data.catalog);
      setNotice(`Fetched ${parsed.data.discoveredCount} videos from ${parsed.data.channelTitle} using the YouTube Data API. They remain private until approved.`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not discover channel videos.");
    } finally {
      setDiscovering(false);
    }
  }

  async function addVideo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!videoUrl.trim() || busyVideoId !== null) return;
    setBusyVideoId("new-video");
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/ebook/videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add",
          url: videoUrl.trim(),
          ...(videoTitle.trim() ? { title: videoTitle.trim() } : {}),
          ...(newTranscript.trim() ? { transcript: newTranscript } : {}),
        }),
      });
      const body: unknown = await response.json();
      if (!response.ok) throw await responseError(response, body);
      const parsed = z.object({ catalog: DirectorVideoCatalogSchema }).safeParse(body);
      if (!parsed.success) throw new Error("Video was added with an invalid catalog response.");
      setCatalog(parsed.data.catalog);
      setVideoUrl("");
      setVideoTitle("");
      setNewTranscript("");
      setNotice("Video added to the private Director queue. It is not public until approved.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not add this video.");
    } finally {
      setBusyVideoId(null);
    }
  }

  async function runAction(action: Action, video: Video, transcript?: string) {
    setBusyVideoId(video.videoId);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/ebook/videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          videoId: video.videoId,
          ...(transcript === undefined ? {} : { transcript }),
        }),
      });
      const body: unknown = await response.json();
      if (!response.ok) throw await responseError(response, body);
      const parsed = z.object({ catalog: DirectorVideoCatalogSchema }).safeParse(body);
      if (!parsed.success) throw new Error("Video operation returned an invalid catalog.");
      setCatalog(parsed.data.catalog);
      if (action === "save-transcript") {
        setTranscriptDrafts((current) => ({ ...current, [video.videoId]: "" }));
      }
      setNotice(action === "save-transcript"
        ? `Timestamped transcript saved privately for “${video.title}”.`
        : action === "approve"
          ? `“${video.title}” is now playable and searchable in the public Library.`
          : action === "unpublish"
            ? `“${video.title}” was removed from the public Library.`
            : `“${video.title}” was deleted from Director.`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Video operation failed.");
    } finally {
      setBusyVideoId(null);
    }
  }

  const videos = catalog?.videos ?? [];
  const readyCount = videos.filter((video) => video.status === "ready").length;
  const publishedCount = videos.filter((video) => video.status === "published").length;

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-4 rounded-2xl border border-slate-800 bg-slate-900/40 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-6">
        <div>
          <h2 className="text-lg font-semibold text-white">Lifegate Broadcast</h2>
          <p className="mt-1 text-sm text-slate-400">Fetch the latest 100 public uploads through YouTube’s official API. No page scraping or automatic transcription. Set YOUTUBE_API_KEY with YouTube Data API v3 enabled.</p>
        </div>
        <button
          type="button"
          onClick={discoverVideos}
          disabled={discovering || busyVideoId !== null}
          className="min-h-12 shrink-0 rounded-xl bg-cyan-400 px-5 text-sm font-bold text-slate-950 disabled:opacity-50"
        >
          {discovering ? "Fetching videos…" : "Fetch channel videos"}
        </button>
      </section>

      <form onSubmit={addVideo} className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900/40 p-4 sm:p-6">
        <div>
          <h2 className="text-lg font-semibold text-white">Add one video</h2>
          <p className="mt-1 text-sm text-slate-400">Add an individual YouTube URL and optionally paste its timestamped transcript now or later.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm font-medium text-slate-300">
            YouTube URL
            <input
              type="url"
              required
              value={videoUrl}
              onChange={(event) => setVideoUrl(event.target.value)}
              placeholder="https://youtu.be/…"
              className="mt-2 min-h-12 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 text-base text-white placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none"
            />
          </label>
          <label className="block text-sm font-medium text-slate-300">
            Title (optional)
            <input
              type="text"
              maxLength={200}
              value={videoTitle}
              onChange={(event) => setVideoTitle(event.target.value)}
              placeholder="Name this video"
              className="mt-2 min-h-12 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 text-base text-white placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none"
            />
          </label>
        </div>
        <label className="block text-sm font-medium text-slate-300">
          Timestamped transcript (optional)
          <textarea
            value={newTranscript}
            onChange={(event) => setNewTranscript(event.target.value)}
            placeholder={"Paste transcript lines, for example:\n0:00 Welcome to the message\n1:24 Today we are learning…\n\nSRT/VTT timestamp cues are also supported."}
            rows={5}
            className="mt-2 min-h-32 w-full rounded-xl border border-slate-700 bg-slate-950 p-4 text-base leading-relaxed text-white placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none"
          />
        </label>
        <button
          type="submit"
          disabled={busyVideoId !== null || discovering || !videoUrl.trim()}
          className="min-h-12 rounded-xl bg-cyan-400 px-5 text-sm font-bold text-slate-950 disabled:opacity-50"
        >
          {busyVideoId === "new-video" ? "Adding video…" : "Add to private queue"}
        </button>
      </form>

      <div className="grid gap-3 sm:grid-cols-3">
        {[
          ["Total discovered", videos.length],
          ["Ready for approval", readyCount],
          ["Published", publishedCount],
        ].map(([label, count]) => (
          <div key={label} className="rounded-xl border border-slate-800 bg-slate-900/30 p-4">
            <p className="text-xs text-slate-500">{label}</p>
            <p className="mt-1 text-2xl font-bold text-white">{count}</p>
          </div>
        ))}
      </div>

      {error && <p role="alert" className="rounded-xl border border-rose-900 bg-rose-950/40 p-4 text-sm text-rose-200">{error}</p>}
      {notice && <p role="status" className="rounded-xl border border-emerald-900 bg-emerald-950/30 p-4 text-sm text-emerald-200">{notice}</p>}
      {loading ? (
        <p className="py-10 text-center text-sm text-slate-500">Loading private video catalog…</p>
      ) : videos.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-slate-800 p-10 text-center text-sm text-slate-500">
          No videos in the private queue yet. Fetch the channel or add an individual video URL.
        </p>
      ) : (
        <ul className="space-y-4">
          {videos.map((video) => {
            const busy = busyVideoId === video.videoId;
            return (
              <li key={video.videoId} className="rounded-2xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                  <a
                    href={video.youtubeUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="block aspect-video w-full max-w-56 shrink-0 overflow-hidden rounded-xl bg-slate-800"
                    aria-label={`Open ${video.title} on YouTube`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`https://i.ytimg.com/vi/${video.videoId}/mqdefault.jpg`}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  </a>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-semibold leading-snug text-white">{video.title}</h3>
                      <span className={`rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ${
                        video.status === "published"
                          ? "border-emerald-800 bg-emerald-950/40 text-emerald-300"
                          : video.status === "ready"
                            ? "border-cyan-800 bg-cyan-950/40 text-cyan-300"
                            : video.status === "failed"
                              ? "border-rose-800 bg-rose-950/40 text-rose-300"
                              : "border-slate-700 bg-slate-800 text-slate-300"
                      }`}>
                        {video.status}
                      </span>
                    </div>
                    <p className="mt-2 text-xs text-slate-500">
                      {video.segments.length > 0
                        ? `${video.segments.length} timed transcript segments · processed ${new Date(video.updatedAt).toLocaleString()}`
                        : `Added ${new Date(video.updatedAt).toLocaleString()}`}
                    </p>
                    {video.error && <p className="mt-3 rounded-lg bg-rose-950/40 p-3 text-xs leading-relaxed text-rose-200">{video.error}</p>}
                    {video.segments.length > 0 && (
                      <details className="mt-4">
                        <summary className="flex min-h-12 cursor-pointer items-center text-sm font-semibold text-cyan-300">
                          Review transcript
                        </summary>
                        <div className="max-h-64 overflow-y-auto rounded-xl border border-slate-800 bg-slate-950/70 p-3">
                          {video.segments.map((segment, index) => (
                            <p key={`${segment.startSeconds}-${index}`} className="border-b border-slate-800/70 py-2 text-xs leading-relaxed text-slate-300 last:border-0">
                              <span className="mr-2 font-semibold text-amber-300">{formatTime(segment.startSeconds)}</span>
                              {segment.text}
                            </p>
                          ))}
                        </div>
                      </details>
                    )}
                    <div className="mt-4 flex flex-wrap gap-2">
                      {video.status !== "published" && (
                        <>
                          {video.segments.length > 0 && (
                            <button
                              type="button"
                              onClick={() => runAction("approve", video)}
                              disabled={discovering || busyVideoId !== null}
                              className="min-h-12 rounded-xl bg-emerald-400 px-4 text-sm font-bold text-slate-950 disabled:opacity-50"
                            >
                              Approve for Library
                            </button>
                          )}
                        </>
                      )}
                      {video.status === "published" && (
                        <button
                          type="button"
                          onClick={() => runAction("unpublish", video)}
                          disabled={discovering || busyVideoId !== null}
                          className="min-h-12 rounded-xl border border-amber-800 px-4 text-sm font-semibold text-amber-200 disabled:opacity-50"
                        >
                          Unpublish
                        </button>
                      )}
                      {video.status !== "published" && (
                        <button
                          type="button"
                          onClick={() => runAction("delete", video)}
                          disabled={discovering || busyVideoId !== null}
                          className="min-h-12 rounded-xl border border-rose-900 px-4 text-sm font-semibold text-rose-300 disabled:opacity-50"
                        >
                          Delete
                        </button>
                      )}
                      {video.status === "published" && (
                        <a href="/library/videos" className="flex min-h-12 items-center rounded-xl border border-slate-700 px-4 text-sm font-semibold text-slate-300">
                          View Library
                        </a>
                      )}
                    </div>
                    {video.status !== "published" && (
                      <details className="mt-4">
                        <summary className="flex min-h-12 cursor-pointer items-center text-sm font-semibold text-cyan-300">
                          {video.segments.length ? "Replace timestamped transcript" : "Paste timestamped transcript"}
                        </summary>
                        <label className="block text-sm font-medium text-slate-300">
                          Transcript
                          <textarea
                            value={transcriptDrafts[video.videoId] ?? ""}
                            onChange={(event) => setTranscriptDrafts((current) => ({
                              ...current,
                              [video.videoId]: event.target.value,
                            }))}
                            placeholder={"Paste lines like “0:00 Welcome” or SRT/VTT cues with start --> end timestamps."}
                            rows={5}
                            className="mt-2 min-h-32 w-full rounded-xl border border-slate-700 bg-slate-950 p-4 text-base leading-relaxed text-white placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none"
                          />
                        </label>
                        <button
                          type="button"
                          onClick={() => runAction("save-transcript", video, transcriptDrafts[video.videoId] ?? "")}
                          disabled={discovering || busyVideoId !== null || !(transcriptDrafts[video.videoId] ?? "").trim()}
                          className="mt-3 min-h-12 rounded-xl border border-cyan-800 px-4 text-sm font-semibold text-cyan-200 disabled:opacity-50"
                        >
                          {busy ? "Saving transcript…" : "Save transcript"}
                        </button>
                      </details>
                    )}
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

function formatTime(seconds: number): string {
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
    : `${minutes}:${String(remaining).padStart(2, "0")}`;
}
