"use client";

import { FormEvent, useEffect, useState } from "react";
import { z } from "zod";
import { LibraryVideoCatalogSchema } from "@/lib/schemas/library-video";

const TranscriptResponseSchema = z.object({
  transcript: z.string().min(1),
  videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  segments: z.array(z.object({
    startSeconds: z.number().finite().min(0),
    endSeconds: z.number().finite().min(0),
    text: z.string().min(1),
  }).strict()).min(1),
}).strict();

const SaveResponseSchema = z.object({
  video: LibraryVideoCatalogSchema.shape.videos.element,
}).strict();

const ErrorResponseSchema = z.object({ error: z.string() });

export default function LibraryVideoManager() {
  const [catalog, setCatalog] = useState<z.infer<typeof LibraryVideoCatalogSchema> | null>(null);
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function loadVideos() {
    const response = await fetch("/api/library/videos");
    const body: unknown = await response.json();
    if (!response.ok) {
      const parsedError = ErrorResponseSchema.safeParse(body);
      throw new Error(parsedError.success ? parsedError.data.error : "Could not load videos.");
    }
    const parsed = LibraryVideoCatalogSchema.safeParse(body);
    if (!parsed.success) throw new Error("The video catalog returned invalid data.");
    setCatalog(parsed.data);
  }

  useEffect(() => {
    loadVideos()
      .catch((loadError: unknown) => setError(loadError instanceof Error ? loadError.message : "Could not load videos."))
      .finally(() => setLoading(false));
  }, []);

  async function addVideo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const transcriptResponse = await fetch("/api/fetch-youtube-transcript", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const transcriptBody: unknown = await transcriptResponse.json();
      if (!transcriptResponse.ok) {
        const parsedError = ErrorResponseSchema.safeParse(transcriptBody);
        throw new Error(parsedError.success ? parsedError.data.error : "Could not fetch this video's transcript.");
      }
      const transcript = TranscriptResponseSchema.safeParse(transcriptBody);
      if (!transcript.success) throw new Error("The transcript response did not contain timestamped captions.");

      const saveResponse = await fetch("/api/library/videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          title,
          segments: transcript.data.segments,
        }),
      });
      const saveBody: unknown = await saveResponse.json();
      if (!saveResponse.ok) {
        const parsedError = ErrorResponseSchema.safeParse(saveBody);
        throw new Error(parsedError.success ? parsedError.data.error : "Could not save this video.");
      }
      const saved = SaveResponseSchema.safeParse(saveBody);
      if (!saved.success) throw new Error("The saved video response was invalid.");
      setCatalog((current) => ({
        updatedAt: new Date().toISOString(),
        videos: [saved.data.video, ...(current?.videos ?? []).filter((video) => video.videoId !== saved.data.video.videoId)],
      }));
      setUrl("");
      setTitle("");
      setNotice("Video added and its transcript is ready for questions.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not add this video.");
    } finally {
      setSaving(false);
    }
  }

  async function removeVideo(videoId: string) {
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/library/videos", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId }),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        const parsedError = ErrorResponseSchema.safeParse(body);
        throw new Error(parsedError.success ? parsedError.data.error : "Could not remove this video.");
      }
      setCatalog((current) => current
        ? { ...current, videos: current.videos.filter((video) => video.videoId !== videoId) }
        : current);
      setNotice("Video removed from the library.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not remove this video.");
    }
  }

  return (
    <div className="space-y-8">
      <form onSubmit={addVideo} className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4 sm:p-6">
        <h2 className="text-lg font-semibold text-white">Add a YouTube video</h2>
        <p className="mt-1 text-sm text-slate-400">The video must have captions available. We store caption text and timestamps, not the video itself.</p>
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <label className="block text-xs font-semibold text-slate-400">
            YouTube URL
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              type="url"
              required
              placeholder="https://youtube.com/watch?v=…"
              className="mt-2 min-h-12 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-base text-white outline-none focus:border-amber-500"
            />
          </label>
          <label className="block text-xs font-semibold text-slate-400">
            Video title
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              required
              maxLength={200}
              placeholder="Give this video a title"
              className="mt-2 min-h-12 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-base text-white outline-none focus:border-amber-500"
            />
          </label>
        </div>
        <button
          type="submit"
          disabled={saving}
          className="mt-5 min-h-12 rounded-xl bg-amber-500 px-5 text-sm font-bold text-slate-950 disabled:opacity-60"
        >
          {saving ? "Fetching captions…" : "Add video"}
        </button>
        {error && <p role="alert" className="mt-4 rounded-xl border border-rose-900 bg-rose-950/40 p-3 text-sm text-rose-200">{error}</p>}
        {notice && <p role="status" className="mt-4 rounded-xl border border-emerald-900 bg-emerald-950/30 p-3 text-sm text-emerald-200">{notice}</p>}
      </form>

      <section>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-white">Published videos</h2>
          <a href="/library/ask" className="flex min-h-12 items-center rounded-xl border border-slate-700 px-4 text-sm font-semibold text-slate-300">Ask about these videos</a>
        </div>
        {loading ? (
          <p className="py-8 text-sm text-slate-500">Loading videos…</p>
        ) : !catalog || catalog.videos.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-slate-800 p-8 text-center text-sm text-slate-500">No videos have been added yet.</p>
        ) : (
          <ul className="space-y-3">
            {catalog.videos.map((video) => (
              <li key={video.videoId} className="flex flex-col gap-3 rounded-2xl border border-slate-800 bg-slate-900/30 p-4 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <h3 className="font-semibold text-white">{video.title}</h3>
                  <p className="mt-1 text-xs text-slate-500">Transcript indexed · {new Date(video.addedAt).toLocaleDateString()}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <a href={video.youtubeUrl} target="_blank" rel="noreferrer" className="flex min-h-12 items-center rounded-xl border border-slate-700 px-4 text-sm font-semibold text-slate-300">Watch ↗</a>
                  <button type="button" onClick={() => removeVideo(video.videoId)} className="min-h-12 rounded-xl border border-rose-900/70 px-4 text-sm font-semibold text-rose-300">Remove</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
