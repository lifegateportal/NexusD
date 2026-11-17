"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import ShortsPlayer from "@/app/components/ShortsPlayer";
import { deleteShortSource, getShortSource, saveShortSource } from "@/lib/short-video-store";
import {
  ShortCatalogSchema,
  MAX_SHORT_DURATION_SECONDS,
  ShortProjectSchema,
  type ShortCropKeyframe,
  type ShortFrameSlot,
  type ShortProject,
  type ShortSummary,
} from "@/lib/schemas/video-short";
import { DirectorVideoCatalogSchema } from "@/lib/schemas/library-video";

const ErrorSchema = z.object({ error: z.string() });
const SuggestionResponseSchema = z.object({
  suggestions: z.array(z.object({
    startSeconds: z.number().finite().min(0),
    endSeconds: z.number().finite().min(0),
    title: z.string(),
    hook: z.string(),
    reason: z.string(),
  })),
});
const UploadResponseSchema = z.object({
  presignedUrl: z.string().url(),
  sourceUrl: z.string().url(),
  contentType: z.enum(["video/mp4", "video/webm"]),
});

type Video = z.infer<typeof DirectorVideoCatalogSchema>["videos"][number];
type Suggestion = z.infer<typeof SuggestionResponseSchema>["suggestions"][number];

async function requestJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  const body: unknown = await response.json();
  if (!response.ok) {
    const parsed = ErrorSchema.safeParse(body);
    throw new Error(parsed.success ? parsed.data.error : `Request failed (HTTP ${response.status}).`);
  }
  return body;
}

function slugify(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 52) || "video-short";
}

function getFramePosition(slot: ShortFrameSlot, timeSeconds: number): ShortCropKeyframe {
  const frames = [...slot.keyframes].sort((a, b) => a.timeSeconds - b.timeSeconds);
  if (frames.length === 0) return { timeSeconds, x: 50, y: 50, zoom: 1 };
  if (timeSeconds <= frames[0].timeSeconds) return frames[0];
  for (let index = 1; index < frames.length; index += 1) {
    const previous = frames[index - 1];
    const next = frames[index];
    if (timeSeconds <= next.timeSeconds) {
      const progress = (timeSeconds - previous.timeSeconds) / Math.max(0.001, next.timeSeconds - previous.timeSeconds);
      return {
        timeSeconds,
        x: previous.x + (next.x - previous.x) * progress,
        y: previous.y + (next.y - previous.y) * progress,
        zoom: previous.zoom + (next.zoom - previous.zoom) * progress,
      };
    }
  }
  return frames[frames.length - 1];
}

function filterCaptions(video: Video | undefined, startSeconds: number, endSeconds: number) {
  return (video?.segments ?? []).filter(
    (segment) => segment.endSeconds > startSeconds && segment.startSeconds < endSeconds,
  );
}

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

export default function ShortsStudio() {
  const [videos, setVideos] = useState<Video[]>([]);
  const [shorts, setShorts] = useState<ShortSummary[]>([]);
  const [selectedVideoId, setSelectedVideoId] = useState("");
  const [project, setProject] = useState<ShortProject | null>(null);
  const [localVideoUrl, setLocalVideoUrl] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const localFileRef = useRef<File | null>(null);

  const selectedVideo = useMemo(
    () => videos.find((video) => video.videoId === (project?.sourceVideoId ?? selectedVideoId)),
    [project?.sourceVideoId, selectedVideoId, videos],
  );
  const activeSlotIndex = project
    ? Math.max(0, project.frameSlots.findIndex((slot) =>
      currentTime >= slot.startSeconds && currentTime <= slot.endSeconds,
    ))
    : 0;
  const activeSlot = project?.frameSlots[activeSlotIndex];
  const framePosition = activeSlot ? getFramePosition(activeSlot, currentTime) : null;

  useEffect(() => {
    let active = true;
    Promise.all([
      requestJson("/api/ebook/videos", { cache: "no-store" }),
      requestJson("/api/ebook/shorts", { cache: "no-store" }),
    ]).then(([videoBody, shortBody]) => {
      const videoCatalog = DirectorVideoCatalogSchema.safeParse(videoBody);
      const shortCatalog = ShortCatalogSchema.safeParse(shortBody);
      if (!videoCatalog.success || !shortCatalog.success) {
        throw new Error("Nexus Director returned an invalid video or Shorts catalog.");
      }
      if (active) {
        setVideos(videoCatalog.data.videos);
        setShorts(shortCatalog.data.shorts);
      }
    }).catch((loadError: unknown) => {
      if (active) setError(loadError instanceof Error ? loadError.message : "Could not load Shorts Studio.");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => () => {
    if (localVideoUrl?.startsWith("blob:")) URL.revokeObjectURL(localVideoUrl);
  }, [localVideoUrl]);

  async function refreshShorts(): Promise<void> {
    const body = await requestJson("/api/ebook/shorts", { cache: "no-store" });
    const parsed = ShortCatalogSchema.safeParse(body);
    if (!parsed.success) throw new Error("Nexus Director returned an invalid Shorts catalog.");
    setShorts(parsed.data.shorts);
  }

  function createProject() {
    const video = videos.find((item) => item.videoId === selectedVideoId);
    if (!video || video.segments.length === 0) {
      setError("Choose a video with a saved timestamped transcript first.");
      return;
    }
    const startSeconds = video.segments[0].startSeconds;
    const endSeconds = Math.min(
      video.segments[video.segments.length - 1].endSeconds,
      startSeconds + 60,
    );
    if (endSeconds <= startSeconds) {
      setError("This transcript does not contain a usable clip range.");
      return;
    }
    const title = `${video.title} Short`;
    const projectSlug = `${slugify(video.title)}-${video.videoId.slice(0, 5).toLocaleLowerCase()}-${Date.now().toString(36)}`;
    setProject(ShortProjectSchema.parse({
      slug: projectSlug,
      title,
      description: "",
      sourceVideoId: video.videoId,
      source: { type: "youtube", videoId: video.videoId, videoTitle: video.title },
      startSeconds,
      endSeconds,
      frameSlots: [{
        startSeconds,
        endSeconds,
        aspectRatio: "9:16",
        fit: "cover",
        keyframes: [{ timeSeconds: startSeconds, x: 50, y: 50, zoom: 1 }],
      }],
      captions: filterCaptions(video, startSeconds, endSeconds),
      captionsEnabled: true,
      captionPosition: "bottom",
      captionSize: "medium",
      status: "draft",
      updatedAt: new Date().toISOString(),
    }));
    setLocalVideoUrl(null);
    localFileRef.current = null;
    setCurrentTime(startSeconds);
    setSuggestions([]);
    setError("");
    setNotice("");
  }

  async function openProject(slug: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const body = await requestJson(`/api/ebook/shorts/${encodeURIComponent(slug)}`, { cache: "no-store" });
      const parsed = ShortProjectSchema.safeParse(body);
      if (!parsed.success) throw new Error("The saved short has an invalid format.");
      setProject(parsed.data);
      setCurrentTime(parsed.data.startSeconds);
      setSuggestions([]);
      setLocalVideoUrl(null);
      localFileRef.current = null;
      if (parsed.data.source.type === "upload" && !parsed.data.source.sourceUrl) {
        const blob = await getShortSource(parsed.data.slug);
        if (blob) {
          const file = new File([blob], parsed.data.source.fileName, { type: blob.type });
          localFileRef.current = file;
          setLocalVideoUrl(URL.createObjectURL(blob));
        }
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not open this short.");
    } finally {
      setBusy(false);
    }
  }

  function updateProject(patch: Partial<ShortProject>) {
    setProject((current) => current ? { ...current, ...patch } : current);
  }

  function updateRange(field: "startSeconds" | "endSeconds", value: string) {
    if (!project || !activeSlot || project.frameSlots.length !== 1 || value.trim() === "") return;
    const nextValue = Number(value);
    const startSeconds = field === "startSeconds" ? nextValue : project.startSeconds;
    const endSeconds = field === "endSeconds" ? nextValue : project.endSeconds;
    if (!Number.isFinite(nextValue) || startSeconds < 0 || endSeconds <= startSeconds) return;
    if (endSeconds - startSeconds > MAX_SHORT_DURATION_SECONDS) {
      setError("Shorts can be up to 3 minutes long.");
      return;
    }
    const frameSlots = [{
      ...activeSlot,
      startSeconds,
      endSeconds,
      keyframes: activeSlot.keyframes.map((frame) => ({
        ...frame,
        timeSeconds: Math.max(startSeconds, Math.min(endSeconds, frame.timeSeconds)),
      })),
    }];
    updateProject({
      [field]: nextValue,
      frameSlots,
      captions: filterCaptions(selectedVideo, startSeconds, endSeconds),
    });
    if (field === "startSeconds") setCurrentTime(nextValue);
    setError("");
  }

  function setKeyframe(timeSeconds: number, x: number, y: number, zoom: number) {
    if (!project) return;
    const index = project.frameSlots.findIndex((slot) =>
      timeSeconds >= slot.startSeconds && timeSeconds <= slot.endSeconds,
    );
    if (index < 0) return;
    const frame = { timeSeconds, x, y, zoom };
    const frameSlots = project.frameSlots.map((slot, slotIndex) => {
      if (slotIndex !== index) return slot;
      const keyframes = [
        ...slot.keyframes.filter((item) => Math.abs(item.timeSeconds - timeSeconds) > 0.1),
        frame,
      ].sort((a, b) => a.timeSeconds - b.timeSeconds);
      return { ...slot, keyframes };
    });
    updateProject({ frameSlots });
  }

  function splitFrameSlot() {
    if (!project || !activeSlot || !framePosition) return;
    if (currentTime < activeSlot.startSeconds + 0.5 || currentTime > activeSlot.endSeconds - 0.5) {
      setError("Move the playhead at least half a second inside a framing slot before splitting it.");
      return;
    }
    const left = {
      ...activeSlot,
      endSeconds: currentTime,
      keyframes: activeSlot.keyframes.filter((frame) => frame.timeSeconds < currentTime),
    };
    const right = {
      ...activeSlot,
      startSeconds: currentTime,
      keyframes: [
        { timeSeconds: currentTime, x: framePosition.x, y: framePosition.y, zoom: framePosition.zoom },
        ...activeSlot.keyframes.filter((frame) => frame.timeSeconds > currentTime),
      ],
    };
    const frameSlots = [...project.frameSlots];
    frameSlots.splice(activeSlotIndex, 1, left, right);
    updateProject({ frameSlots });
    setError("");
  }

  async function addAiSuggestions() {
    if (!selectedVideo || selectedVideo.segments.length === 0) {
      setError("Choose a video with a saved timestamped transcript first.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const segments: typeof selectedVideo.segments = [];
      let totalText = 0;
      for (const segment of selectedVideo.segments) {
        const size = segment.text.length + 32;
        if (totalText + size > 29000) break;
        segments.push(segment);
        totalText += size;
      }
      const body = await requestJson("/api/ebook/shorts/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: selectedVideo.title, segments }),
      });
      const parsed = SuggestionResponseSchema.safeParse(body);
      if (!parsed.success) throw new Error("AI returned invalid short suggestions.");
      setSuggestions(parsed.data.suggestions);
      setNotice("AI suggestions are transcript-based. Preview and approve the timing before publishing.");
    } catch (suggestionError) {
      setError(suggestionError instanceof Error ? suggestionError.message : "Could not suggest short clips.");
    } finally {
      setBusy(false);
    }
  }

  function useSuggestion(suggestion: Suggestion) {
    if (!project) return;
    const video = selectedVideo;
    const frameSlots: ShortFrameSlot[] = [{
      startSeconds: suggestion.startSeconds,
      endSeconds: suggestion.endSeconds,
      aspectRatio: activeSlot?.aspectRatio ?? "9:16",
      fit: activeSlot?.fit ?? "cover",
      keyframes: [{ timeSeconds: suggestion.startSeconds, x: 50, y: 50, zoom: 1 }],
    }];
    updateProject({
      title: suggestion.title,
      startSeconds: suggestion.startSeconds,
      endSeconds: suggestion.endSeconds,
      frameSlots,
      captions: filterCaptions(video, suggestion.startSeconds, suggestion.endSeconds),
    });
    setCurrentTime(suggestion.startSeconds);
    setError("");
  }

  async function saveDraft() {
    if (!project) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const body = await requestJson("/api/ebook/shorts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", project }),
      });
      const parsed = z.object({ project: ShortProjectSchema }).safeParse(body);
      if (!parsed.success) throw new Error("The saved short response is invalid.");
      setProject(parsed.data.project);
      await refreshShorts();
      setNotice("Short draft saved privately.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save this short.");
    } finally {
      setBusy(false);
    }
  }

  async function uploadSourceForPublish(input: ShortProject): Promise<ShortProject> {
    if (input.source.type !== "upload" || input.source.sourceUrl) return input;
    let file = localFileRef.current;
    if (!file) {
      const blob = await getShortSource(input.slug);
      if (blob) file = new File([blob], input.source.fileName, { type: blob.type });
    }
    if (!file) throw new Error("Re-select the authorized source video before publishing this uploaded short.");
    const contentType = file.type || (file.name.toLocaleLowerCase().endsWith(".webm") ? "video/webm" : "video/mp4");
    if (contentType !== "video/mp4" && contentType !== "video/webm") {
      throw new Error("Use an MP4 or WebM source video.");
    }
    const uploadBody = await requestJson("/api/ebook/shorts/source", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: file.name, contentType, size: file.size }),
    });
    const upload = UploadResponseSchema.safeParse(uploadBody);
    if (!upload.success) throw new Error("The source upload service returned an invalid response.");
    const uploadResponse = await fetch(upload.data.presignedUrl, {
      method: "PUT",
      headers: { "Content-Type": upload.data.contentType },
      body: file,
    });
    if (!uploadResponse.ok) throw new Error(`Video upload failed (HTTP ${uploadResponse.status}). Check R2 upload CORS and try again.`);
    return {
      ...input,
      source: { type: "upload", fileName: file.name, sourceUrl: upload.data.sourceUrl },
    };
  }

  async function publishProject() {
    if (!project) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const publishable = await uploadSourceForPublish(project);
      const body = await requestJson("/api/ebook/shorts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "publish", project: { ...publishable, status: "published" } }),
      });
      const parsed = z.object({ project: ShortProjectSchema }).safeParse(body);
      if (!parsed.success) throw new Error("The published short response is invalid.");
      setProject(parsed.data.project);
      await refreshShorts();
      setNotice("Short published. Its public page is ready to share.");
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : "Could not publish this short.");
    } finally {
      setBusy(false);
    }
  }

  async function unpublishProject() {
    if (!project) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await requestJson("/api/ebook/shorts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "unpublish", slug: project.slug }),
      });
      const body = await requestJson(`/api/ebook/shorts/${encodeURIComponent(project.slug)}`, { cache: "no-store" });
      const parsed = ShortProjectSchema.safeParse(body);
      if (!parsed.success) throw new Error("The unpublished short response is invalid.");
      setProject(parsed.data);
      await refreshShorts();
      setNotice("Short removed from the public Library; the private draft remains.");
    } catch (unpublishError) {
      setError(unpublishError instanceof Error ? unpublishError.message : "Could not unpublish this short.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteProject() {
    if (!project || project.status === "published") return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await requestJson("/api/ebook/shorts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", slug: project.slug }),
      });
      setProject(null);
      setLocalVideoUrl(null);
      localFileRef.current = null;
      await refreshShorts();
      try {
        await deleteShortSource(project.slug);
        setNotice("Private short draft deleted.");
      } catch {
        setNotice("Private short draft deleted, but its local browser source could not be removed.");
      }
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Could not delete this short.");
    } finally {
      setBusy(false);
    }
  }

  async function selectSourceFile(file: File | undefined) {
    if (!project || !file) return;
    if (file.size > 500 * 1024 * 1024) {
      setError("Source videos must be 500 MB or smaller.");
      return;
    }
    const contentType = file.type || (file.name.toLocaleLowerCase().endsWith(".webm") ? "video/webm" : "");
    if (contentType !== "video/mp4" && contentType !== "video/webm") {
      setError("Choose an MP4 or WebM video file.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await saveShortSource(project.slug, file);
      if (localVideoUrl?.startsWith("blob:")) URL.revokeObjectURL(localVideoUrl);
      const url = URL.createObjectURL(file);
      localFileRef.current = file;
      setLocalVideoUrl(url);
      updateProject({ source: { type: "upload", fileName: file.name } });
      setNotice("Source saved in this browser for editing. It will upload to R2 only when you publish.");
    } catch (sourceError) {
      setError(sourceError instanceof Error ? sourceError.message : "Could not keep this source in browser storage.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <p className="py-12 text-center text-sm text-slate-400">Loading Shorts Studio…</p>;
  }

  return (
    <div className="space-y-6 pb-20 lg:pb-0">
      <header>
        <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-cyan-300">Transcript-powered editing</p>
        <h2 className="mt-2 text-2xl font-bold text-white">Shorts Studio</h2>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-400">
          Build shareable web shorts from saved transcripts. YouTube embeds need no source download; authorized uploads unlock clean, manually keyframed reframing.
        </p>
      </header>

      {error && <p role="alert" className="rounded-xl border border-rose-900 bg-rose-950/40 p-4 text-sm text-rose-200">{error}</p>}
      {notice && <p role="status" className="rounded-xl border border-emerald-900 bg-emerald-950/30 p-4 text-sm text-emerald-200">{notice}</p>}

      <section className="grid gap-4 rounded-2xl border border-slate-800 bg-slate-900/40 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end sm:p-6">
        <label className="block text-sm font-medium text-slate-300">
          Start from a saved transcript
          <select
            value={selectedVideoId}
            onChange={(event) => setSelectedVideoId(event.target.value)}
            className="mt-2 min-h-12 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 text-base text-white focus:border-cyan-400 focus:outline-none"
          >
            <option value="">Choose a video…</option>
            {videos.filter((video) => video.segments.length > 0).map((video) => (
              <option key={video.videoId} value={video.videoId}>{video.title}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={createProject}
          disabled={busy || !selectedVideoId}
          className="min-h-12 rounded-xl bg-cyan-400 px-5 text-sm font-bold text-slate-950 disabled:opacity-50"
        >
          Create short draft
        </button>
      </section>

      {suggestions.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-lg font-semibold text-white">AI clip ideas</h3>
          <ul className="grid gap-3 lg:grid-cols-2">
            {suggestions.map((suggestion, index) => (
              <li key={`${suggestion.startSeconds}-${index}`} className="rounded-xl border border-cyan-900/70 bg-cyan-950/20 p-4">
                <h4 className="font-semibold text-white">{suggestion.title}</h4>
                <p className="mt-2 text-sm text-cyan-100">{suggestion.hook}</p>
                <p className="mt-2 text-xs leading-relaxed text-slate-400">{suggestion.reason}</p>
                <p className="mt-2 text-xs text-slate-500">{formatTime(suggestion.startSeconds)}–{formatTime(suggestion.endSeconds)}</p>
                <button
                  type="button"
                  onClick={() => useSuggestion(suggestion)}
                  disabled={!project}
                  className="mt-3 min-h-12 rounded-lg border border-cyan-800 px-4 text-sm font-semibold text-cyan-200 disabled:opacity-50"
                >
                  Use this moment
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(16rem,0.8fr)_minmax(0,2fr)]">
        <aside className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-lg font-semibold text-white">Your shorts</h3>
            <button
              type="button"
              onClick={addAiSuggestions}
              disabled={busy || !selectedVideo?.segments.length}
              className="min-h-12 rounded-lg border border-violet-800 px-3 text-xs font-semibold text-violet-200 disabled:opacity-50"
            >
              {busy ? "Working…" : "AI: find moments"}
            </button>
          </div>
          {shorts.length === 0 ? (
            <p className="rounded-xl border border-dashed border-slate-700 p-5 text-sm text-slate-400">Saved drafts and published shorts will appear here.</p>
          ) : (
            <ul className="space-y-2">
              {shorts.map((short) => (
                <li key={short.slug}>
                  <button
                    type="button"
                    onClick={() => openProject(short.slug)}
                    disabled={busy}
                    className={`min-h-16 w-full rounded-xl border p-3 text-left ${
                      project?.slug === short.slug
                        ? "border-cyan-700 bg-cyan-950/30"
                        : "border-slate-800 bg-slate-900/40"
                    }`}
                  >
                    <span className="block font-semibold text-white">{short.title}</span>
                    <span className="mt-1 block text-xs text-slate-400">{short.status} · {short.sourceType}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        {!project ? (
          <section className="flex min-h-72 items-center justify-center rounded-2xl border border-dashed border-slate-700 p-8 text-center text-sm text-slate-400">
            Choose a transcribed video to start editing, or open a saved short.
          </section>
        ) : (
          <section className="space-y-5 rounded-2xl border border-slate-800 bg-slate-900/30 p-4 sm:p-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h3 className="text-xl font-bold text-white">Edit short</h3>
                <p className="mt-1 text-xs text-slate-400">/{project.slug} · {project.status}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={saveDraft} disabled={busy} className="min-h-12 rounded-xl border border-slate-700 px-4 text-sm font-semibold text-white disabled:opacity-50">
                  Save draft
                </button>
                <button type="button" onClick={publishProject} disabled={busy} className="min-h-12 rounded-xl bg-emerald-400 px-4 text-sm font-bold text-slate-950 disabled:opacity-50">
                  {busy ? "Publishing…" : project.status === "published" ? "Update published short" : "Publish to Library"}
                </button>
                {project.status === "published" && (
                  <button type="button" onClick={unpublishProject} disabled={busy} className="min-h-12 rounded-xl border border-amber-800 px-4 text-sm font-semibold text-amber-200 disabled:opacity-50">
                    Unpublish
                  </button>
                )}
              </div>
            </div>

            {project.status === "published" && (
              <a href={`/library/shorts/${project.slug}`} target="_blank" rel="noreferrer" className="inline-flex min-h-12 items-center text-sm font-semibold text-cyan-300">
                Open public short
              </a>
            )}

            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(17rem,0.8fr)]">
              <div className="space-y-4">
                <ShortsPlayer
                  project={project}
                  localVideoUrl={localVideoUrl}
                  editable
                  onTimeChange={setCurrentTime}
                  onCropChange={setKeyframe}
                />
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block text-sm font-medium text-slate-300">
                    Start (seconds)
                    <input
                      type="number"
                      min="0"
                      max={Math.max(0, project.endSeconds - 0.1)}
                      step="0.1"
                      value={project.startSeconds}
                      disabled={project.frameSlots.length > 1}
                      onChange={(event) => updateRange("startSeconds", event.target.value)}
                      className="mt-2 min-h-12 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 text-base text-white disabled:opacity-50"
                    />
                  </label>
                  <label className="block text-sm font-medium text-slate-300">
                    End (seconds)
                    <input
                      type="number"
                      min={project.startSeconds + 0.1}
                      max={project.startSeconds + MAX_SHORT_DURATION_SECONDS}
                      step="0.1"
                      value={project.endSeconds}
                      disabled={project.frameSlots.length > 1}
                      onChange={(event) => updateRange("endSeconds", event.target.value)}
                      className="mt-2 min-h-12 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 text-base text-white disabled:opacity-50"
                    />
                  </label>
                </div>
                <p className="text-xs text-slate-400">
                  Clip length: {formatTime(project.endSeconds - project.startSeconds)} · maximum 3:00
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" onClick={splitFrameSlot} disabled={busy || project.frameSlots.length >= 100} className="min-h-12 rounded-lg border border-cyan-800 px-4 text-sm font-semibold text-cyan-200 disabled:opacity-50">
                    Split framing slot at {formatTime(currentTime)}
                  </button>
                  <button
                    type="button"
                    onClick={() => framePosition && setKeyframe(currentTime, framePosition.x, framePosition.y, framePosition.zoom)}
                    className="min-h-12 rounded-lg border border-slate-700 px-4 text-sm font-semibold text-slate-200"
                  >
                    Add crop keyframe
                  </button>
                </div>
                <p className="text-xs leading-relaxed text-slate-400">
                  For uploaded footage, drag the preview to reposition the crop, then add keyframes as the face moves. Positions interpolate between keyframes.
                </p>
              </div>

              <div className="space-y-4">
                <label className="block text-sm font-medium text-slate-300">
                  Short title
                  <input
                    type="text"
                    maxLength={120}
                    value={project.title}
                    onChange={(event) => updateProject({ title: event.target.value })}
                    className="mt-2 min-h-12 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 text-base text-white"
                  />
                </label>
                <label className="block text-sm font-medium text-slate-300">
                  Description
                  <textarea
                    rows={3}
                    maxLength={1000}
                    value={project.description}
                    onChange={(event) => updateProject({ description: event.target.value })}
                    className="mt-2 min-h-24 w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-base text-white"
                  />
                </label>
                <label className="block text-sm font-medium text-slate-300">
                  Video source
                  <select
                    value={project.source.type}
                    onChange={(event) => {
                      if (event.target.value === "youtube" && project.sourceVideoId) {
                        const video = videos.find((item) => item.videoId === project.sourceVideoId);
                        if (video) updateProject({ source: { type: "youtube", videoId: video.videoId, videoTitle: video.title } });
                      } else if (event.target.value === "upload") {
                        updateProject({ source: { type: "upload", fileName: project.source.type === "upload" ? project.source.fileName : "source.mp4" } });
                      }
                    }}
                    className="mt-2 min-h-12 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 text-base text-white"
                  >
                    <option value="youtube">YouTube embed (best-effort crop)</option>
                    <option value="upload">Authorized MP4/WebM upload (reliable crop)</option>
                  </select>
                </label>
                {project.source.type === "upload" && (
                  <div className="space-y-2 rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                    <label className="block text-sm font-medium text-slate-300">
                      Original video file
                      <input
                        type="file"
                        accept="video/mp4,video/webm,.mp4,.webm"
                        onChange={(event) => void selectSourceFile(event.target.files?.[0])}
                        className="mt-2 min-h-12 w-full text-base text-slate-300 file:mr-3 file:min-h-12 file:rounded-lg file:border-0 file:bg-slate-800 file:px-3 file:text-sm file:font-semibold file:text-white"
                      />
                    </label>
                    <p className="text-xs leading-relaxed text-slate-400">
                      The file stays in this browser while editing and uploads to public R2 storage only when you publish. Use only footage you own or are authorized to publish.
                    </p>
                    <p className="text-xs text-slate-500">
                      {localFileRef.current?.name ?? (project.source.sourceUrl ? project.source.fileName : "No local source selected")}
                    </p>
                  </div>
                )}
                {activeSlot && framePosition && (
                  <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                    <h4 className="text-sm font-semibold text-white">Current framing slot</h4>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="block text-sm text-slate-300">
                        Aspect ratio
                        <select
                          value={activeSlot.aspectRatio}
                          onChange={(event) => {
                            const frameSlots = project.frameSlots.map((slot, index) =>
                              index === activeSlotIndex
                                ? { ...slot, aspectRatio: event.target.value as ShortFrameSlot["aspectRatio"] }
                                : slot,
                            );
                            updateProject({ frameSlots });
                          }}
                          className="mt-2 min-h-12 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-base text-white"
                        >
                          <option value="9:16">9:16 vertical</option>
                          <option value="4:5">4:5 portrait</option>
                          <option value="1:1">1:1 square</option>
                          <option value="16:9">16:9 landscape</option>
                        </select>
                      </label>
                      <label className="block text-sm text-slate-300">
                        Fit
                        <select
                          value={activeSlot.fit}
                          onChange={(event) => {
                            const frameSlots = project.frameSlots.map((slot, index) =>
                              index === activeSlotIndex
                                ? { ...slot, fit: event.target.value as ShortFrameSlot["fit"] }
                                : slot,
                            );
                            updateProject({ frameSlots });
                          }}
                          className="mt-2 min-h-12 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-base text-white"
                        >
                          <option value="cover">Crop to fill</option>
                          <option value="contain">Show full frame</option>
                        </select>
                      </label>
                    </div>
                    {(["x", "y", "zoom"] as const).map((axis) => (
                      <label key={axis} className="block text-sm text-slate-300">
                        {axis === "x" ? "Horizontal crop" : axis === "y" ? "Vertical crop" : "Zoom"} · {axis === "zoom" ? `${framePosition[axis].toFixed(2)}×` : `${Math.round(framePosition[axis])}%`}
                        <input
                          type="range"
                          min={axis === "zoom" ? 1 : 0}
                          max={axis === "zoom" ? 3 : 100}
                          step={axis === "zoom" ? 0.05 : 1}
                          value={framePosition[axis]}
                          onChange={(event) => setKeyframe(
                            currentTime,
                            axis === "x" ? Number(event.target.value) : framePosition.x,
                            axis === "y" ? Number(event.target.value) : framePosition.y,
                            axis === "zoom" ? Number(event.target.value) : framePosition.zoom,
                          )}
                          className="mt-1 min-h-12 w-full accent-cyan-400"
                        />
                      </label>
                    ))}
                    <p className="text-xs text-slate-500">
                      {activeSlot.keyframes.length} keyframe{activeSlot.keyframes.length === 1 ? "" : "s"} · slot {formatTime(activeSlot.startSeconds)}–{formatTime(activeSlot.endSeconds)}
                    </p>
                  </div>
                )}
                <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h4 className="text-sm font-semibold text-white">Subtitles</h4>
                    <label className="flex min-h-12 items-center gap-2 text-sm text-slate-300">
                      <input type="checkbox" checked={project.captionsEnabled} onChange={(event) => updateProject({ captionsEnabled: event.target.checked })} className="h-5 w-5 accent-cyan-400" />
                      Show captions
                    </label>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block text-sm text-slate-300">
                      Position
                      <select value={project.captionPosition} onChange={(event) => updateProject({ captionPosition: event.target.value as ShortProject["captionPosition"] })} className="mt-2 min-h-12 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-base text-white">
                        <option value="bottom">Bottom</option><option value="middle">Middle</option><option value="top">Top</option>
                      </select>
                    </label>
                    <label className="block text-sm text-slate-300">
                      Text size
                      <select value={project.captionSize} onChange={(event) => updateProject({ captionSize: event.target.value as ShortProject["captionSize"] })} className="mt-2 min-h-12 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-base text-white">
                        <option value="small">Small</option><option value="medium">Medium</option><option value="large">Large</option>
                      </select>
                    </label>
                  </div>
                  {project.captions.length === 0 ? (
                    <p className="text-xs text-slate-400">No transcript captions fall inside this clip range.</p>
                  ) : (
                    <div className="max-h-72 space-y-2 overflow-y-auto">
                      {project.captions.map((caption, index) => (
                        <label key={`${caption.startSeconds}-${index}`} className="block text-xs text-slate-400">
                          {formatTime(caption.startSeconds)}–{formatTime(caption.endSeconds)}
                          <textarea
                            rows={2}
                            maxLength={2000}
                            value={caption.text}
                            onChange={(event) => {
                              const captions = project.captions.map((item, itemIndex) =>
                                itemIndex === index ? { ...item, text: event.target.value } : item,
                              );
                              updateProject({ captions });
                            }}
                            className="mt-1 min-h-12 w-full rounded-lg border border-slate-700 bg-slate-900 p-2 text-base text-white"
                          />
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap gap-2 border-t border-slate-800 pt-4">
              {project.status === "draft" && (
                <button type="button" onClick={deleteProject} disabled={busy} className="min-h-12 rounded-xl border border-rose-900 px-4 text-sm font-semibold text-rose-300 disabled:opacity-50">
                  Delete draft
                </button>
              )}
              <button type="button" onClick={addAiSuggestions} disabled={busy || !selectedVideo?.segments.length} className="min-h-12 rounded-xl border border-violet-800 px-4 text-sm font-semibold text-violet-200 disabled:opacity-50">
                {busy ? "Working…" : "Suggest moments with AI"}
              </button>
              {project.status === "published" && (
                <a href={`/library/shorts/${project.slug}`} target="_blank" rel="noreferrer" className="flex min-h-12 items-center rounded-xl border border-slate-700 px-4 text-sm font-semibold text-slate-200">
                  View public page
                </a>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
