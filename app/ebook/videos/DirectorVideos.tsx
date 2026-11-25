"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { z } from "zod";
import LibraryYouTubePlayer from "@/app/components/LibraryYouTubePlayer";
import { DirectorVideoCatalogSchema } from "@/lib/schemas/library-video";

const ErrorSchema = z.object({ error: z.string() });
type Catalog = z.infer<typeof DirectorVideoCatalogSchema>;
type Video = Catalog["videos"][number];
type Action = "save-transcript" | "save-details" | "approve" | "unpublish" | "delete";

async function responseError(response: Response, body: unknown): Promise<Error> {
  const parsed = ErrorSchema.safeParse(body);
  return new Error(parsed.success ? parsed.data.error : `Request failed (HTTP ${response.status}).`);
}

export default function DirectorVideos() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [discovering, setDiscovering] = useState(false);
  const [busyVideoId, setBusyVideoId] = useState<string | null>(null);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [videoTitle, setVideoTitle] = useState("");
  const [newTranscript, setNewTranscript] = useState("");
  const [newPlaylists, setNewPlaylists] = useState("");
  const [newSermonStart, setNewSermonStart] = useState("");
  const [newSermonEnd, setNewSermonEnd] = useState("");
  const [queueSearch, setQueueSearch] = useState("");
  const [visibleVideoLimit, setVisibleVideoLimit] = useState(50);
  const [previewVideoId, setPreviewVideoId] = useState<string | null>(null);
  const [transcriptDrafts, setTranscriptDrafts] = useState<Record<string, string>>({});
  const [playlistDrafts, setPlaylistDrafts] = useState<Record<string, string>>({});
  const [sermonStartDrafts, setSermonStartDrafts] = useState<Record<string, string>>({});
  const [sermonEndDrafts, setSermonEndDrafts] = useState<Record<string, string>>({});
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
    try {
      setNextPageToken(window.localStorage.getItem("nexus-director-youtube-next-page") || null);
    } catch {
      setError("Browser storage is unavailable; the channel page cursor will not persist across refreshes.");
    }
    loadCatalog()
      .catch((loadError: unknown) => setError(loadError instanceof Error ? loadError.message : "Could not load videos."))
      .finally(() => setLoading(false));
  }, [loadCatalog]);

  async function discoverVideos(pageToken?: string) {
    setDiscovering(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/ebook/videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "discover", ...(pageToken ? { pageToken } : {}) }),
      });
      const body: unknown = await response.json();
      if (!response.ok) throw await responseError(response, body);
      const parsed = z.object({
        catalog: DirectorVideoCatalogSchema,
        discoveredCount: z.number().int().nonnegative(),
        channelTitle: z.string(),
        nextPageToken: z.string().optional(),
      }).safeParse(body);
      if (!parsed.success) throw new Error("Video discovery returned an invalid catalog.");
      setCatalog(parsed.data.catalog);
      const nextToken = parsed.data.nextPageToken ?? null;
      setNextPageToken(nextToken);
      try {
        if (nextToken) window.localStorage.setItem("nexus-director-youtube-next-page", nextToken);
        else window.localStorage.removeItem("nexus-director-youtube-next-page");
      } catch {
        setError("Videos were fetched, but browser storage could not save the paging cursor. Keep this page open or restart from newest after refresh.");
      }
      setNotice(`Fetched ${parsed.data.discoveredCount} more videos from ${parsed.data.channelTitle}. They remain private until approved.${nextToken ? " Fetch the next batch to continue through the channel." : " The channel’s upload list is complete."}`);
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
          ...(newPlaylists.trim()
            ? { playlists: parsePlaylistNames(newPlaylists) }
            : {}),
          ...(newSermonStart.trim()
            ? { sermonStartSeconds: parseTimeInput(newSermonStart) }
            : {}),
          ...(newSermonEnd.trim()
            ? { sermonEndSeconds: parseTimeInput(newSermonEnd) }
            : {}),
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
      setNewPlaylists("");
      setNewSermonStart("");
      setNewSermonEnd("");
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
          ...(action === "save-details" ? {
            playlists: parsePlaylistNames(playlistDrafts[video.videoId] ?? video.playlists.join(",")),
            sermonStartSeconds: parseOptionalTimeInput(sermonStartDrafts[video.videoId] ?? (
              video.sermonStartSeconds === undefined ? "" : formatTime(video.sermonStartSeconds)
            )),
            sermonEndSeconds: parseOptionalTimeInput(sermonEndDrafts[video.videoId] ?? (
              video.sermonEndSeconds === undefined ? "" : formatTime(video.sermonEndSeconds)
            )),
          } : {}),
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
        : action === "save-details"
          ? `Playlist and sermon boundaries saved for “${video.title}”.`
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
  const matchingVideos = useMemo(() => {
    const needle = queueSearch.trim().toLocaleLowerCase();
    return videos.filter((video) => !needle || video.title.toLocaleLowerCase().includes(needle));
  }, [queueSearch, videos]);
  const visibleVideos = matchingVideos.slice(0, visibleVideoLimit);
  const readyCount = videos.filter((video) =>
    video.status === "ready"
    && video.sermonStartSeconds !== undefined
    && video.sermonEndSeconds !== undefined
    && video.sermonEndSeconds > video.sermonStartSeconds,
  ).length;
  const publishedCount = videos.filter((video) => video.status === "published").length;

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-4 rounded-2xl border border-slate-800 bg-slate-900/40 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-6">
        <div>
          <h2 className="text-lg font-semibold text-white">Lifegate Broadcast</h2>
          <p className="mt-1 text-sm text-slate-400">Fetch the entire public channel in 50-video batches through YouTube’s official API. No scraping or automatic transcription. Set YOUTUBE_API_KEY with YouTube Data API v3 enabled. Fetched videos stay private until you approve them.</p>
        </div>
        <div className="flex flex-col gap-2 sm:items-end">
          <button
            type="button"
            onClick={() => discoverVideos()}
            disabled={discovering || busyVideoId !== null}
            className="min-h-12 shrink-0 rounded-xl bg-cyan-400 px-5 text-sm font-bold text-slate-950 disabled:opacity-50"
          >
            {discovering ? "Fetching videos…" : "Restart from newest"}
          </button>
          {nextPageToken && (
            <button
              type="button"
              onClick={() => discoverVideos(nextPageToken)}
              disabled={discovering || busyVideoId !== null}
              className="min-h-12 shrink-0 rounded-xl border border-slate-700 px-5 text-sm font-semibold text-slate-200 disabled:opacity-50"
            >
              Fetch next 50
            </button>
          )}
        </div>
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
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm font-medium text-slate-300">
            Playlists (comma-separated)
            <input
              type="text"
              value={newPlaylists}
              onChange={(event) => setNewPlaylists(event.target.value)}
              placeholder="Prayer, Healing, Sunday service"
              className="mt-2 min-h-12 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 text-base text-white placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none"
            />
          </label>
          <label className="block text-sm font-medium text-slate-300">
            Sermon start (required before publishing)
            <input
              type="text"
              value={newSermonStart}
              onChange={(event) => setNewSermonStart(event.target.value)}
              placeholder="1:23:15 or 4995"
              className="mt-2 min-h-12 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 text-base text-white placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none"
            />
          </label>
          <label className="block text-sm font-medium text-slate-300">
            Sermon end (required before publishing)
            <input
              type="text"
              value={newSermonEnd}
              onChange={(event) => setNewSermonEnd(event.target.value)}
              placeholder="1:58:30 or 7110"
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
          ["Videos in queue", videos.length],
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
      <div>
        <h2 className="text-xl font-bold text-white">Director queue</h2>
        <p className="mt-1 text-sm text-slate-400">Unapproved fetched entries stay private. Only videos you approve appear in the public PJDL.</p>
        <label className="mt-4 block sm:max-w-md">
          <span className="sr-only">Search Director videos</span>
          <input
            type="search"
            value={queueSearch}
            onChange={(event) => {
              setQueueSearch(event.target.value);
              setVisibleVideoLimit(50);
            }}
            placeholder="Search channel and queued videos…"
            className="min-h-12 w-full rounded-xl border border-slate-700 bg-slate-900 px-4 text-base text-white placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none"
          />
        </label>
      </div>
      {loading ? (
        <p className="py-10 text-center text-sm text-slate-500">Loading private video catalog…</p>
      ) : matchingVideos.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-slate-800 p-10 text-center text-sm text-slate-500">
          {videos.length ? "No queued videos match that search." : "No videos in the private queue yet. Fetch the channel or add an individual video URL."}
        </p>
      ) : (
        <ul className="space-y-4">
          {visibleVideos.map((video) => {
            const busy = busyVideoId === video.videoId;
            const hasSermonBounds = video.sermonStartSeconds !== undefined
              && video.sermonEndSeconds !== undefined
              && video.sermonEndSeconds > video.sermonStartSeconds;
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
                        ? `${video.segments.length} timestamped segments · updated ${new Date(video.updatedAt).toLocaleString()}`
                        : `Added ${new Date(video.updatedAt).toLocaleString()}`}
                    </p>
                    {video.playlists.length > 0 && (
                      <p className="mt-2 text-xs text-cyan-200">Playlists: {video.playlists.join(", ")}</p>
                    )}
                    {(video.sermonStartSeconds !== undefined || video.sermonEndSeconds !== undefined) && (
                      <p className="mt-1 text-xs text-amber-200">
                        Sermon: {video.sermonStartSeconds === undefined ? "not set" : formatTime(video.sermonStartSeconds)}
                        {"–"}
                        {video.sermonEndSeconds === undefined ? "not set" : formatTime(video.sermonEndSeconds)}
                      </p>
                    )}
                    {!hasSermonBounds && (
                      <p className="mt-2 text-xs text-amber-200">
                        Set and save both sermon boundaries before this video can appear in the Library.
                      </p>
                    )}
                    {video.error && <p className="mt-3 rounded-lg bg-rose-950/40 p-3 text-xs leading-relaxed text-rose-200">{video.error}</p>}
                    <button
                      type="button"
                      onClick={() => setPreviewVideoId((current) => current === video.videoId ? null : video.videoId)}
                      className="mt-3 min-h-12 rounded-xl border border-cyan-800 px-4 text-sm font-semibold text-cyan-200"
                    >
                      {previewVideoId === video.videoId ? "Hide preview" : "Preview and set sermon times"}
                    </button>
                    {previewVideoId === video.videoId && (
                      <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/70 p-3">
                        <p className="mb-2 text-xs leading-relaxed text-slate-400">
                          Drag the timeline to find the sermon start and end, then save the boundaries below.
                        </p>
                        <LibraryYouTubePlayer
                          videoId={video.videoId}
                          title={video.title}
                          startSeconds={video.sermonStartSeconds ?? 0}
                          endSeconds={video.sermonEndSeconds ?? 0}
                          initialTimeSeconds={video.sermonStartSeconds ?? 0}
                          editing
                          onSetStart={(seconds) => setSermonStartDrafts((current) => ({
                            ...current,
                            [video.videoId]: formatTime(seconds),
                          }))}
                          onSetEnd={(seconds) => setSermonEndDrafts((current) => ({
                            ...current,
                            [video.videoId]: formatTime(seconds),
                          }))}
                          onClose={() => setPreviewVideoId(null)}
                        />
                      </div>
                    )}
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
                              disabled={discovering || busyVideoId !== null || !hasSermonBounds}
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
                    <details className="mt-4">
                      <summary className="flex min-h-12 cursor-pointer items-center text-sm font-semibold text-cyan-300">
                        Edit playlist and sermon boundaries
                      </summary>
                      <p className="mt-2 text-xs leading-relaxed text-slate-400">
                        Save both sermon boundaries to publish this video. The Library only shows the section between these timestamps.
                      </p>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <label className="block text-sm font-medium text-slate-300">
                          Playlists (comma-separated)
                          <input
                            type="text"
                            value={playlistDrafts[video.videoId] ?? video.playlists.join(", ")}
                            onChange={(event) => setPlaylistDrafts((current) => ({
                              ...current,
                              [video.videoId]: event.target.value,
                            }))}
                            placeholder="Prayer, Healing, Sunday service"
                            className="mt-2 min-h-12 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 text-base text-white placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none"
                          />
                        </label>
                        <label className="block text-sm font-medium text-slate-300">
                          Sermon start (required)
                          <input
                            type="text"
                            value={sermonStartDrafts[video.videoId] ?? (
                              video.sermonStartSeconds === undefined ? "" : formatTime(video.sermonStartSeconds)
                            )}
                            onChange={(event) => setSermonStartDrafts((current) => ({
                              ...current,
                              [video.videoId]: event.target.value,
                            }))}
                            placeholder="1:23:15 or 4995"
                            className="mt-2 min-h-12 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 text-base text-white placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none"
                          />
                        </label>
                        <label className="block text-sm font-medium text-slate-300">
                          Sermon end (required)
                          <input
                            type="text"
                            value={sermonEndDrafts[video.videoId] ?? (
                              video.sermonEndSeconds === undefined ? "" : formatTime(video.sermonEndSeconds)
                            )}
                            onChange={(event) => setSermonEndDrafts((current) => ({
                              ...current,
                              [video.videoId]: event.target.value,
                            }))}
                            placeholder="1:58:30 or 7110"
                            className="mt-2 min-h-12 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 text-base text-white placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none"
                          />
                        </label>
                      </div>
                      <button
                        type="button"
                        onClick={() => runAction("save-details", video)}
                        disabled={discovering || busyVideoId !== null}
                        className="mt-3 min-h-12 rounded-xl border border-cyan-800 px-4 text-sm font-semibold text-cyan-200 disabled:opacity-50"
                      >
                        {busy ? "Saving details…" : "Save playlist and sermon boundaries"}
                      </button>
                    </details>
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
      {!loading && matchingVideos.length > visibleVideos.length && (
        <button
          type="button"
          onClick={() => setVisibleVideoLimit((limit) => limit + 50)}
          className="min-h-12 w-full rounded-xl border border-slate-700 text-sm font-semibold text-slate-200"
        >
          Show more videos ({visibleVideos.length} of {matchingVideos.length})
        </button>
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

function parsePlaylistNames(value: string): string[] {
  return [...new Set(value.split(",").map((name) => name.trim()).filter(Boolean))];
}

function parseOptionalTimeInput(value: string): number | null {
  const trimmed = value.trim();
  return trimmed ? parseTimeInput(trimmed) : null;
}

function parseTimeInput(value: string): number {
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds)) return seconds;
    throw new Error("Enter a finite timestamp.");
  }
  const parts = trimmed.split(":");
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+(?:\.\d+)?$/.test(part))) {
    throw new Error("Enter time in seconds, MM:SS, or HH:MM:SS format.");
  }
  const values = parts.map(Number);
  if (values.slice(1).some((part) => part >= 60)) {
    throw new Error("Minutes and seconds in a timestamp must be under 60.");
  }
  const seconds = values.length === 2
    ? values[0] * 60 + values[1]
    : values[0] * 3600 + values[1] * 60 + values[2];
  if (!Number.isFinite(seconds)) throw new Error("Enter a finite timestamp.");
  return seconds;
}
