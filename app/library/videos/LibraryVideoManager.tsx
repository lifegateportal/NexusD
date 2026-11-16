"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
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

const UploadedMediaTranscriptSchema = z.object({
  transcript: z.string().min(1),
  segments: TranscriptResponseSchema.shape.segments,
}).strict();

const YouTubeAudioTranscriptSchema = TranscriptResponseSchema;

const SaveResponseSchema = z.object({
  video: LibraryVideoCatalogSchema.shape.videos.element,
}).strict();

const ErrorResponseSchema = z.object({ error: z.string() });
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export default function LibraryVideoManager() {
  const [catalog, setCatalog] = useState<z.infer<typeof LibraryVideoCatalogSchema> | null>(null);
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const mediaInputRef = useRef<HTMLInputElement>(null);

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
      let segments: z.infer<typeof TranscriptResponseSchema>["segments"];
      if (mediaFile) {
        if (mediaFile.size > MAX_UPLOAD_BYTES) {
          throw new Error("Media files must be 100 MB or smaller. Select a smaller file or use the YouTube URL transcription option.");
        }
        setProgress("Transcribing uploaded audio/video…");
        const formData = new FormData();
        formData.set("file", mediaFile);
        const response = await fetch("/api/transcribe", { method: "POST", body: formData });
        const body: unknown = await response.json();
        if (!response.ok) {
          const parsedError = ErrorResponseSchema.safeParse(body);
          throw new Error(parsedError.success ? parsedError.data.error : `Could not transcribe the uploaded media (HTTP ${response.status}).`);
        }
        const parsed = UploadedMediaTranscriptSchema.safeParse(body);
        if (!parsed.success) throw new Error("The audio transcription response did not contain timestamped speech.");
        segments = parsed.data.segments;
      } else {
        setProgress("Checking YouTube captions…");
        const captionsResponse = await fetch("/api/fetch-youtube-transcript", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
        });
        const captionsBody: unknown = await captionsResponse.json();
        const captions = captionsResponse.ok ? TranscriptResponseSchema.safeParse(captionsBody) : null;
        if (captions?.success) {
          segments = captions.data.segments;
        } else {
          setProgress("Captions unavailable; transcribing the YouTube audio…");
          const audioResponse = await fetch("/api/library/videos/transcribe-youtube", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url }),
          });
          const audioBody: unknown = await audioResponse.json();
          if (!audioResponse.ok) {
            const parsedError = ErrorResponseSchema.safeParse(audioBody);
            throw new Error(parsedError.success
              ? `YouTube captions were unavailable. Audio transcription failed: ${parsedError.data.error}`
              : "YouTube captions were unavailable and audio transcription failed.");
          }
          const audioTranscript = YouTubeAudioTranscriptSchema.safeParse(audioBody);
          if (!audioTranscript.success) throw new Error("Audio transcription returned no timestamped speech.");
          segments = audioTranscript.data.segments;
        }
      }

      const saveResponse = await fetch("/api/library/videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          title,
          segments,
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
      setMediaFile(null);
      if (mediaInputRef.current) mediaInputRef.current.value = "";
      setNotice("Video added and its transcript is ready for questions.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not add this video.");
    } finally {
      setSaving(false);
      setProgress("");
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
        <p className="mt-1 text-sm text-slate-400">We use captions when available; otherwise we transcribe the audio. The audio is processed for transcription and is not stored.</p>
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
        <label className="mt-4 block text-xs font-semibold text-slate-400">
          Or upload the source audio/video (optional, max 100 MB)
          <input
            ref={mediaInputRef}
            type="file"
            accept="audio/*,video/*"
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null;
              setMediaFile(file);
              if (file && file.size > MAX_UPLOAD_BYTES) {
                setError("This file is over the 100 MB upload limit. Select a smaller file or use the YouTube URL transcription option.");
              } else {
                setError("");
              }
            }}
            className="mt-2 block min-h-12 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-base text-slate-300 file:mr-3 file:min-h-10 file:rounded-lg file:border-0 file:bg-slate-800 file:px-3 file:text-sm file:font-semibold file:text-white"
          />
          {mediaFile && <span className="mt-1 block font-normal text-slate-500">{mediaFile.name}</span>}
        </label>
        <button
          type="submit"
          disabled={saving}
          className="mt-5 min-h-12 rounded-xl bg-amber-500 px-5 text-sm font-bold text-slate-950 disabled:opacity-60"
        >
          {saving ? progress || "Preparing transcript…" : "Add video"}
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
