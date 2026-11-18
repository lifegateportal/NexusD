"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import ShortsPlayer from "@/app/components/ShortsPlayer";
import { deleteShortSource, getShortSource, saveShortSource } from "@/lib/short-video-store";
import {
  ShortAgentSettingsSchema,
  ShortCatalogSchema,
  MAX_SHORT_DURATION_SECONDS,
  ShortOverlayPresetResponseSchema,
  ShortOverlaySchema,
  ShortProjectSchema,
  type ShortBrollClip,
  type ShortCropKeyframe,
  type ShortFrameSlot,
  type ShortMusicTrack,
  type ShortOverlay,
  type ShortOverlayPreset,
  type ShortOverlayPresetLayer,
  type ShortProject,
  type ShortSummary,
} from "@/lib/schemas/video-short";
import { DirectorVideoCatalogSchema } from "@/lib/schemas/library-video";
import {
  ShortBrollSuggestionsResponseSchema,
  ShortMusicSuggestionsResponseSchema,
  type ShortBrollSuggestion,
  type ShortMusicSuggestion,
} from "@/lib/schemas/short-media";

const ErrorSchema = z.object({ error: z.string() });
const SuggestionResponseSchema = z.object({
  videoStartSeconds: z.number().finite().min(0),
  videoEndSeconds: z.number().finite().min(0),
  sermonStartSeconds: z.number().finite().min(0).nullable(),
  sermonEndSeconds: z.number().finite().min(0).nullable(),
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
  contentType: z.enum([
    "video/mp4",
    "video/webm",
    "audio/mpeg",
    "audio/mp4",
    "audio/aac",
    "audio/wav",
    "audio/x-wav",
    "image/png",
    "image/jpeg",
    "image/webp",
  ]),
});

type Video = z.infer<typeof DirectorVideoCatalogSchema>["videos"][number];
type Suggestion = z.infer<typeof SuggestionResponseSchema>["suggestions"][number];
type SuggestedBoundaries = Pick<
  z.infer<typeof SuggestionResponseSchema>,
  "videoStartSeconds" | "videoEndSeconds" | "sermonStartSeconds" | "sermonEndSeconds"
>;

async function requestJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  const body: unknown = await response.json();
  if (!response.ok) {
    const parsed = ErrorSchema.safeParse(body);
    throw new Error(parsed.success ? parsed.data.error : `Request failed (HTTP ${response.status}).`);
  }
  return body;
}

async function uploadShortAsset(file: File): Promise<string> {
  const body = await requestJson("/api/ebook/shorts/source", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: file.name, contentType: file.type, size: file.size }),
  });
  const upload = UploadResponseSchema.safeParse(body);
  if (!upload.success || upload.data.contentType !== file.type) {
    throw new Error("The Shorts asset upload service returned invalid file details.");
  }
  const response = await fetch(upload.data.presignedUrl, {
    method: "PUT",
    headers: { "Content-Type": file.type },
    body: file,
  });
  if (!response.ok) throw new Error(`Asset upload failed (HTTP ${response.status}).`);
  return upload.data.sourceUrl;
}

function readMediaDuration(file: File, type: "audio" | "video"): Promise<number> {
  const media = document.createElement(type);
  const objectUrl = URL.createObjectURL(file);
  media.preload = "metadata";
  media.src = objectUrl;
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      media.removeEventListener("loadedmetadata", onLoaded);
      media.removeEventListener("error", onError);
      media.removeAttribute("src");
      media.load();
      URL.revokeObjectURL(objectUrl);
    };
    const onLoaded = () => {
      const duration = media.duration;
      cleanup();
      if (!Number.isFinite(duration) || duration <= 0 || duration > 3600) {
        reject(new Error("Media duration must be between 0 and 60 minutes."));
        return;
      }
      resolve(duration);
    };
    const onError = () => {
      cleanup();
      reject(new Error("The selected media file could not be read by this browser."));
    };
    media.addEventListener("loadedmetadata", onLoaded, { once: true });
    media.addEventListener("error", onError, { once: true });
  });
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
  if (frames.length === 0) return { timeSeconds, x: 50, y: 50, zoom: 1, fit: slot.fit };
  if (timeSeconds <= frames[0].timeSeconds) return { ...frames[0], fit: frames[0].fit ?? slot.fit };
  for (let index = 1; index < frames.length; index += 1) {
    const previous = frames[index - 1];
    const next = frames[index];
    if (timeSeconds < next.timeSeconds) {
      const progress = (timeSeconds - previous.timeSeconds) / Math.max(0.001, next.timeSeconds - previous.timeSeconds);
      return {
        timeSeconds,
        x: previous.x + (next.x - previous.x) * progress,
        y: previous.y + (next.y - previous.y) * progress,
        zoom: previous.zoom + (next.zoom - previous.zoom) * progress,
        fit: previous.fit ?? slot.fit,
      };
    }
  }
  const last = frames[frames.length - 1];
  return { ...last, fit: last.fit ?? slot.fit };
}

function filterCaptions(video: Video | undefined, startSeconds: number, endSeconds: number) {
  return (video?.segments ?? []).filter(
    (segment) => segment.endSeconds > startSeconds && segment.startSeconds < endSeconds,
  );
}

function resizeFrameSlots(
  slots: ShortFrameSlot[],
  startSeconds: number,
  endSeconds: number,
): ShortFrameSlot[] {
  const sorted = [...slots].sort((a, b) => a.startSeconds - b.startSeconds);
  const boundaries = [
    startSeconds,
    ...sorted.flatMap((slot) => [slot.startSeconds, slot.endSeconds])
      .filter((time) => time > startSeconds && time < endSeconds),
    endSeconds,
  ].sort((a, b) => a - b).filter((time, index, values) =>
    index === 0 || time - values[index - 1] > 0.001,
  );
  return boundaries.slice(0, -1).flatMap((slotStart, index) => {
    const slotEnd = boundaries[index + 1];
    if (slotEnd <= slotStart) return [];
    const midpoint = (slotStart + slotEnd) / 2;
    const source = sorted.find((slot) => midpoint >= slot.startSeconds && midpoint <= slot.endSeconds)
      ?? (midpoint < sorted[0].startSeconds ? sorted[0] : sorted[sorted.length - 1]);
    const samplePosition = (timeSeconds: number) =>
      getFramePosition(source, Math.max(source.startSeconds, Math.min(source.endSeconds, timeSeconds)));
    const keyframes = [
      { ...samplePosition(slotStart), timeSeconds: slotStart },
      ...source.keyframes.filter((frame) => frame.timeSeconds > slotStart && frame.timeSeconds < slotEnd),
      { ...samplePosition(slotEnd), timeSeconds: slotEnd },
    ].sort((a, b) => a.timeSeconds - b.timeSeconds)
      .filter((frame, frameIndex, frames) =>
        frameIndex === 0 || frame.timeSeconds - frames[frameIndex - 1].timeSeconds > 0.001,
      );
    return [{ ...source, startSeconds: slotStart, endSeconds: slotEnd, keyframes }];
  });
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

function presetLayerToOverlay(
  layer: ShortOverlayPresetLayer,
  startSeconds: number,
  endSeconds: number,
): ShortOverlay {
  const base = {
    id: crypto.randomUUID(),
    startSeconds,
    endSeconds,
    opacity: 1,
    fontSize: 28,
    textColor: "#ffffff",
    backgroundColor: "transparent",
    borderColor: layer.accentColor,
    borderWidth: 2,
    borderRadius: 8,
    zIndex: 60,
    text: layer.text,
  };
  const style = {
    headline: {
      type: "text" as const, left: 7, top: 10, width: 86, height: 28,
      fontSize: 42, textStyle: "headline" as const,
    },
    "lower-third": {
      type: "text" as const, left: 5, top: 72, width: 90, height: 20,
      fontSize: 24, textStyle: "lower-third" as const,
      backgroundColor: "#101827", borderRadius: 10, opacity: 0.96,
    },
    "pill-label": {
      type: "text" as const, left: 7, top: 8, width: 48, height: 12,
      fontSize: 16, textStyle: "pill" as const,
      backgroundColor: "#111827", borderWidth: 1, borderRadius: 100,
    },
    "outline-frame": {
      type: "frame" as const, left: 3, top: 3, width: 94, height: 94,
      frameStyle: "outline" as const, borderWidth: 2, borderRadius: 12,
    },
    "corner-frame": {
      type: "frame" as const, left: 3, top: 3, width: 94, height: 94,
      frameStyle: "corner-brackets" as const, borderWidth: 3, borderRadius: 8,
    },
    "neon-frame": {
      type: "frame" as const, left: 3, top: 3, width: 94, height: 94,
      frameStyle: "neon" as const, borderWidth: 2, borderRadius: 14, opacity: 0.9,
    },
  } satisfies Record<ShortOverlayPresetLayer["style"], Record<string, unknown>>;
  return ShortOverlaySchema.parse({ ...base, ...style[layer.style] });
}

export default function ShortsStudio() {
  const [videos, setVideos] = useState<Video[]>([]);
  const [shorts, setShorts] = useState<ShortSummary[]>([]);
  const [selectedVideoId, setSelectedVideoId] = useState("");
  const [project, setProject] = useState<ShortProject | null>(null);
  const [localVideoUrl, setLocalVideoUrl] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [suggestionsVideoId, setSuggestionsVideoId] = useState("");
  const [suggestedBoundaries, setSuggestedBoundaries] = useState<SuggestedBoundaries | null>(null);
  const [webBrollSuggestions, setWebBrollSuggestions] = useState<ShortBrollSuggestion[]>([]);
  const [webMusicSuggestions, setWebMusicSuggestions] = useState<ShortMusicSuggestion[]>([]);
  const [mediaSuggestionsProjectSlug, setMediaSuggestionsProjectSlug] = useState("");
  const [mediaSearchKind, setMediaSearchKind] = useState<"broll" | "music" | null>(null);
  const [agentInstructions, setAgentInstructions] = useState("");
  const [overlayPresets, setOverlayPresets] = useState<ShortOverlayPreset[]>([]);
  const [overlayBrief, setOverlayBrief] = useState("");
  const [sermonBoundaryDrafts, setSermonBoundaryDrafts] = useState<Record<string, { start: string; end: string }>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [scrollEditorOnUpdate, setScrollEditorOnUpdate] = useState(false);
  const localFileRef = useRef<File | null>(null);
  const editorRef = useRef<HTMLElement>(null);

  const selectedVideo = useMemo(
    () => videos.find((video) => video.videoId === (project?.sourceVideoId ?? selectedVideoId)),
    [project?.sourceVideoId, selectedVideoId, videos],
  );
  const sourceVideoBounds = selectedVideo?.segments.length
    ? {
      start: selectedVideo.segments[0].startSeconds,
      end: selectedVideo.segments[selectedVideo.segments.length - 1].endSeconds,
    }
    : null;
  const sermonBoundaryDraft = selectedVideo
    ? sermonBoundaryDrafts[selectedVideo.videoId] ?? {
      start: selectedVideo.sermonStartSeconds?.toString() ?? "",
      end: selectedVideo.sermonEndSeconds?.toString() ?? "",
    }
    : null;
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
      requestJson("/api/ebook/shorts/settings", { cache: "no-store" }),
    ]).then(([videoBody, shortBody, settingsBody]) => {
      const videoCatalog = DirectorVideoCatalogSchema.safeParse(videoBody);
      const shortCatalog = ShortCatalogSchema.safeParse(shortBody);
      const settings = ShortAgentSettingsSchema.safeParse(settingsBody);
      if (!videoCatalog.success || !shortCatalog.success || !settings.success) {
        throw new Error("Nexus Director returned an invalid video or Shorts catalog.");
      }
      if (active) {
        setVideos(videoCatalog.data.videos);
        setShorts(shortCatalog.data.shorts);
        setAgentInstructions(settings.data.instructions);
        setOverlayPresets(settings.data.overlayPresets);
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

  useEffect(() => {
    if (!scrollEditorOnUpdate || !project) return;
    editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    setScrollEditorOnUpdate(false);
  }, [project, scrollEditorOnUpdate]);

  async function refreshShorts(): Promise<void> {
    const body = await requestJson("/api/ebook/shorts", { cache: "no-store" });
    const parsed = ShortCatalogSchema.safeParse(body);
    if (!parsed.success) throw new Error("Nexus Director returned an invalid Shorts catalog.");
    setShorts(parsed.data.shorts);
  }

  async function saveAgentInstructions() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const body = await requestJson("/api/ebook/shorts/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instructions: agentInstructions, overlayPresets }),
      });
      const parsed = ShortAgentSettingsSchema.safeParse(body);
      if (!parsed.success) throw new Error("The Shorts agent settings response is invalid.");
      setAgentInstructions(parsed.data.instructions);
      setOverlayPresets(parsed.data.overlayPresets);
      setNotice("Reusable Shorts agent instructions saved.");
    } catch (settingsError) {
      setError(settingsError instanceof Error ? settingsError.message : "Could not save Shorts agent instructions.");
    } finally {
      setBusy(false);
    }
  }

  function applyOverlayPreset(preset: ShortOverlayPreset) {
    if (!project) return;
    if (project.overlays.length + preset.layers.length > 20) {
      setError("Remove an overlay layer before applying this preset. Shorts can have up to 20 layers.");
      return;
    }
    const layers = preset.layers.map((layer) =>
      presetLayerToOverlay(layer, project.startSeconds, project.endSeconds),
    );
    updateProject({ overlays: [...project.overlays, ...layers] });
    setNotice(`${preset.name} applied. Customize its text, color, size, position, and timing below.`);
    setError("");
  }

  async function generateOverlayPreset() {
    if (!project || !overlayBrief.trim()) {
      setError("Describe the overlay style you want the agent to create.");
      return;
    }
    if (overlayPresets.length >= 20) {
      setError("The reusable preset library is full. Remove a preset before generating another.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const body = await requestJson("/api/ebook/shorts/overlays/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brief: overlayBrief,
          shortTitle: project.title,
          instructions: agentInstructions,
        }),
      });
      const generated = ShortOverlayPresetResponseSchema.safeParse(body);
      if (!generated.success) throw new Error("The overlay agent returned an invalid preset.");
      if (project.overlays.length + generated.data.layers.length > 20) {
        throw new Error("Remove an overlay layer before applying the generated preset. Shorts can have up to 20 layers.");
      }
      const preset: ShortOverlayPreset = { ...generated.data, id: crypto.randomUUID() };
      const updatedSettings = ShortAgentSettingsSchema.safeParse(await requestJson("/api/ebook/shorts/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instructions: agentInstructions,
          overlayPresets: [...overlayPresets, preset],
        }),
      }));
      if (!updatedSettings.success) throw new Error("The generated preset could not be saved in the preset library.");
      setOverlayPresets(updatedSettings.data.overlayPresets);
      setProject({
        ...project,
        overlays: [
          ...project.overlays,
          ...preset.layers.map((layer) =>
            presetLayerToOverlay(layer, project.startSeconds, project.endSeconds),
          ),
        ],
      });
      setNotice(`${preset.name} generated, saved for reuse, and applied to this short.`);
    } catch (presetError) {
      setError(presetError instanceof Error ? presetError.message : "Could not generate an overlay preset.");
    } finally {
      setBusy(false);
    }
  }

  async function removeOverlayPreset(presetId: string) {
    const remaining = overlayPresets.filter((preset) => preset.id !== presetId);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const body = await requestJson("/api/ebook/shorts/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instructions: agentInstructions, overlayPresets: remaining }),
      });
      const parsed = ShortAgentSettingsSchema.safeParse(body);
      if (!parsed.success) throw new Error("The preset library returned invalid settings.");
      setOverlayPresets(parsed.data.overlayPresets);
      setNotice("Overlay preset removed from the reusable library. Applied project layers are unchanged.");
    } catch (presetError) {
      setError(presetError instanceof Error ? presetError.message : "Could not remove this overlay preset.");
    } finally {
      setBusy(false);
    }
  }

  async function saveSermonBoundaries(
    video: Video,
    startSeconds: number | null,
    endSeconds: number | null,
  ) {
    const first = video.segments[0]?.startSeconds;
    const last = video.segments[video.segments.length - 1]?.endSeconds;
    if (
      (startSeconds !== null && (first === undefined || startSeconds < first || startSeconds > (last ?? first)))
      || (endSeconds !== null && (first === undefined || endSeconds < first || endSeconds > (last ?? first)))
      || (startSeconds !== null && endSeconds !== null && endSeconds <= startSeconds)
    ) {
      setError("Sermon boundaries must be within the transcript and the end must follow the start.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const body = await requestJson("/api/ebook/videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save-details",
          videoId: video.videoId,
          playlists: video.playlists,
          sermonStartSeconds: startSeconds,
          sermonEndSeconds: endSeconds,
        }),
      });
      const parsed = z.object({ catalog: DirectorVideoCatalogSchema }).safeParse(body);
      if (!parsed.success) throw new Error("The sermon boundary save response is invalid.");
      setVideos(parsed.data.catalog.videos);
      setSermonBoundaryDrafts((current) => ({
        ...current,
        [video.videoId]: {
          start: startSeconds?.toString() ?? "",
          end: endSeconds?.toString() ?? "",
        },
      }));
      setNotice("Sermon start and end times saved with the source video.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save sermon boundaries.");
    } finally {
      setBusy(false);
    }
  }

  function addTextOverlay() {
    if (!project || project.overlays.length >= 20) {
      setError("A short can have up to 20 overlay layers.");
      return;
    }
    const overlay: ShortOverlay = {
      id: crypto.randomUUID(),
      type: "text",
      startSeconds: project.startSeconds,
      endSeconds: project.endSeconds,
      left: 10,
      top: 10,
      width: 80,
      height: 20,
      opacity: 1,
      fontSize: 32,
      textColor: "#ffffff",
      backgroundColor: "transparent",
      textStyle: "plain",
      borderColor: "#22d3ee",
      borderWidth: 0,
      borderRadius: 8,
      zIndex: 60,
      text: "Your text",
    };
    updateProject({ overlays: [...project.overlays, overlay] });
    setError("");
  }

  async function uploadOverlay(file: File | undefined, type: "image" | "frame") {
    if (!file || !project) return;
    if (project.overlays.length >= 20) {
      setError("A short can have up to 20 overlay layers.");
      return;
    }
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 10 * 1024 * 1024) {
      setError("Choose a PNG, JPEG, or WebP image up to 10 MB.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const body = await requestJson("/api/ebook/shorts/source", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, contentType: file.type, size: file.size }),
      });
      const upload = UploadResponseSchema.safeParse(body);
      if (!upload.success || upload.data.contentType !== file.type) {
        throw new Error("The overlay upload service returned invalid image details.");
      }
      const response = await fetch(upload.data.presignedUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!response.ok) throw new Error(`Image upload failed (HTTP ${response.status}).`);
      const isFrame = type === "frame";
      const overlay: ShortOverlay = {
        id: crypto.randomUUID(),
        type,
        startSeconds: project.startSeconds,
        endSeconds: project.endSeconds,
        left: isFrame ? 0 : 35,
        top: isFrame ? 0 : 35,
        width: isFrame ? 100 : 30,
        height: isFrame ? 100 : 30,
        opacity: 1,
        fontSize: 32,
        textColor: "#ffffff",
        backgroundColor: "transparent",
        textStyle: "plain",
        borderColor: "#22d3ee",
        borderWidth: 0,
        borderRadius: 8,
        zIndex: 60,
        imageUrl: upload.data.sourceUrl,
      };
      setProject((current) => current
        ? { ...current, overlays: [...current.overlays, overlay] }
        : current);
      setNotice(isFrame
        ? "Transparent frame overlay uploaded and added to the short."
        : "Image overlay uploaded and added to the short.");
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Could not upload this overlay image.");
    } finally {
      setBusy(false);
    }
  }

  async function uploadThumbnail(file: File | undefined) {
    if (!file || !project) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 10 * 1024 * 1024) {
      setError("Choose a PNG, JPEG, or WebP thumbnail up to 10 MB.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const body = await requestJson("/api/ebook/shorts/source", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, contentType: file.type, size: file.size }),
      });
      const upload = UploadResponseSchema.safeParse(body);
      if (!upload.success || upload.data.contentType !== file.type) {
        throw new Error("The thumbnail upload service returned invalid image details.");
      }
      const response = await fetch(upload.data.presignedUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!response.ok) throw new Error(`Thumbnail upload failed (HTTP ${response.status}).`);
      updateProject({ thumbnailUrl: upload.data.sourceUrl });
      setNotice("Thumbnail uploaded. It will appear on the public short card and supported link previews.");
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Could not upload this thumbnail.");
    } finally {
      setBusy(false);
    }
  }

  async function addBrollClip(file: File | undefined) {
    if (!file || !project) return;
    if (project.brollClips.length >= 10) {
      setError("A short can have up to 10 B-roll clips.");
      return;
    }
    if (!["video/mp4", "video/webm"].includes(file.type) || file.size > 500 * 1024 * 1024) {
      setError("Choose an MP4 or WebM B-roll clip up to 500 MB.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const sourceDurationSeconds = await readMediaDuration(file, "video");
      const clipDuration = Math.min(sourceDurationSeconds, project.endSeconds - project.startSeconds);
      if (clipDuration < 0.1) throw new Error("This short does not have enough room for a B-roll clip.");
      const videoUrl = await uploadShortAsset(file);
      const clip: ShortBrollClip = {
        id: crypto.randomUUID(),
        fileName: file.name,
        videoUrl,
        sourceDurationSeconds,
        startSeconds: project.startSeconds,
        endSeconds: project.startSeconds + clipDuration,
        fit: "cover",
        provider: "upload",
      };
      setProject((current) => current && current.slug === project.slug
        ? { ...current, brollClips: [...current.brollClips, clip] }
        : current);
      setNotice("B-roll uploaded and added at the start of this short. Adjust its timeline range below.");
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Could not add this B-roll clip.");
    } finally {
      setBusy(false);
    }
  }

  async function addMusicTrack(file: File | undefined) {
    if (!file || !project) return;
    if (project.musicTracks.length >= 5) {
      setError("A short can have up to 5 instrumental tracks.");
      return;
    }
    const supportedAudioTypes = ["audio/mpeg", "audio/mp4", "audio/aac", "audio/wav", "audio/x-wav"];
    if (!supportedAudioTypes.includes(file.type) || file.size > 100 * 1024 * 1024) {
      setError("Choose an MP3, M4A, AAC, or WAV instrumental file up to 100 MB.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const sourceDurationSeconds = await readMediaDuration(file, "audio");
      const trackDuration = Math.min(sourceDurationSeconds, project.endSeconds - project.startSeconds);
      if (trackDuration < 0.1) throw new Error("This short does not have enough room for an instrumental track.");
      const audioUrl = await uploadShortAsset(file);
      const track: ShortMusicTrack = {
        id: crypto.randomUUID(),
        fileName: file.name,
        audioUrl,
        sourceDurationSeconds,
        startSeconds: project.startSeconds,
        endSeconds: project.startSeconds + trackDuration,
        volume: 0.25,
        fadeInSeconds: Math.min(1, trackDuration / 2),
        fadeOutSeconds: Math.min(2, trackDuration / 2),
        provider: "upload",
        commercialLicenseConfirmed: false,
      };
      setProject((current) => current && current.slug === project.slug
        ? { ...current, musicTracks: [...current.musicTracks, track] }
        : current);
      setNotice("Instrumental uploaded and added with a low starting volume and fades.");
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Could not add this instrumental track.");
    } finally {
      setBusy(false);
    }
  }

  async function findWebMedia(kind: "broll" | "music") {
    if (!project) {
      setError("Open a short draft before searching for web media.");
      return;
    }
    if (project.captions.length === 0) {
      setError("AI media search needs timestamped transcript captions for this short.");
      return;
    }
    setMediaSearchKind(kind);
    setMediaSuggestionsProjectSlug(project.slug);
    setWebBrollSuggestions([]);
    setWebMusicSuggestions([]);
    setError("");
    setNotice("");
    try {
      const body = await requestJson("/api/ebook/shorts/media-suggestions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          title: project.title,
          startSeconds: project.startSeconds,
          endSeconds: project.endSeconds,
          frameSlots: project.frameSlots.map(({ startSeconds, endSeconds, aspectRatio }) => ({
            startSeconds,
            endSeconds,
            aspectRatio,
          })),
          captions: project.captions,
          instructions: agentInstructions,
        }),
      });
      if (kind === "broll") {
        const parsed = ShortBrollSuggestionsResponseSchema.safeParse(body);
        if (!parsed.success || parsed.data.suggestions.length === 0) {
          throw new Error("AI returned invalid web B-roll suggestions.");
        }
        setWebBrollSuggestions(parsed.data.suggestions);
        setNotice("AI matched Pexels footage to transcript moments. Preview a clip, then add it to the editable timeline.");
      } else {
        const parsed = ShortMusicSuggestionsResponseSchema.safeParse(body);
        if (!parsed.success || parsed.data.suggestions.length === 0) {
          throw new Error("AI returned invalid web music suggestions.");
        }
        setWebMusicSuggestions(parsed.data.suggestions);
        setNotice("AI matched instrumental tracks to this message. Preview a track, then add it to the editable timeline.");
      }
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : "Could not find web media for this short.");
    } finally {
      setMediaSearchKind(null);
    }
  }

  function addWebBroll(suggestion: ShortBrollSuggestion) {
    if (!project) return;
    if (project.brollClips.length >= 10) {
      setError("A short can have up to 10 B-roll clips.");
      return;
    }
    const startSeconds = Math.max(project.startSeconds, suggestion.startSeconds);
    const endSeconds = Math.min(
      project.endSeconds,
      suggestion.endSeconds,
      startSeconds + suggestion.durationSeconds,
    );
    if (endSeconds - startSeconds < 2) {
      setError("This B-roll suggestion no longer fits the short. Search again after changing the clip range.");
      return;
    }
    const clip: ShortBrollClip = {
      id: crypto.randomUUID(),
      fileName: suggestion.title,
      videoUrl: suggestion.videoUrl,
      sourceDurationSeconds: suggestion.durationSeconds,
      startSeconds,
      endSeconds,
      fit: "cover",
      provider: "pexels",
      providerPageUrl: suggestion.providerPageUrl,
      creatorName: suggestion.creatorName,
      creatorUrl: suggestion.creatorUrl,
      licenseName: suggestion.licenseName,
      licenseUrl: suggestion.licenseUrl,
    };
    updateProject({ brollClips: [...project.brollClips, clip] });
    setNotice("Pexels B-roll added at the AI-suggested timestamp. Preview and adjust its timeline range before publishing.");
    setError("");
  }

  function addWebMusic(suggestion: ShortMusicSuggestion) {
    if (!project) return;
    if (project.musicTracks.length >= 5) {
      setError("A short can have up to 5 instrumental tracks.");
      return;
    }
    const trackDuration = Math.min(suggestion.durationSeconds, project.endSeconds - project.startSeconds);
    if (trackDuration < 0.1) {
      setError("This instrumental track is too short for the current video range.");
      return;
    }
    const track: ShortMusicTrack = {
      id: crypto.randomUUID(),
      fileName: suggestion.title,
      audioUrl: suggestion.audioUrl,
      sourceDurationSeconds: suggestion.durationSeconds,
      startSeconds: project.startSeconds,
      endSeconds: project.startSeconds + trackDuration,
      volume: 0.25,
      fadeInSeconds: Math.min(1, trackDuration / 2),
      fadeOutSeconds: Math.min(2, trackDuration / 2),
      provider: "jamendo",
      providerPageUrl: suggestion.providerPageUrl,
      creatorName: suggestion.artistName,
      creatorUrl: suggestion.creatorUrl,
      licenseName: suggestion.licenseName,
      licenseUrl: suggestion.licenseUrl,
      commercialLicenseConfirmed: false,
    };
    updateProject({ musicTracks: [...project.musicTracks, track] });
    setNotice("Jamendo instrumental added. Press Play to start the preview with music. Obtain and confirm its commercial license before publishing.");
    setError("");
  }

  function changeBrollRange(id: string, field: "startSeconds" | "endSeconds", value: string) {
    if (!project || value.trim() === "") return;
    const clip = project.brollClips.find((item) => item.id === id);
    const next = Number(value);
    if (!clip || !Number.isFinite(next)) return;
    const startSeconds = field === "startSeconds"
      ? Math.max(project.startSeconds, Math.min(next, clip.endSeconds - 0.1))
      : clip.startSeconds;
    const endSeconds = field === "endSeconds"
      ? Math.max(clip.startSeconds + 0.1, Math.min(next, project.endSeconds, startSeconds + clip.sourceDurationSeconds))
      : Math.min(clip.endSeconds, startSeconds + clip.sourceDurationSeconds);
    updateProject({
      brollClips: project.brollClips.map((item) =>
        item.id === id ? { ...item, startSeconds, endSeconds } : item,
      ),
    });
  }

  function changeMusicRange(id: string, field: "startSeconds" | "endSeconds", value: string) {
    if (!project || value.trim() === "") return;
    const track = project.musicTracks.find((item) => item.id === id);
    const next = Number(value);
    if (!track || !Number.isFinite(next)) return;
    const startSeconds = field === "startSeconds"
      ? Math.max(project.startSeconds, Math.min(next, track.endSeconds - 0.1))
      : track.startSeconds;
    const endSeconds = field === "endSeconds"
      ? Math.max(track.startSeconds + 0.1, Math.min(next, project.endSeconds, startSeconds + track.sourceDurationSeconds))
      : Math.min(track.endSeconds, startSeconds + track.sourceDurationSeconds);
    const fadeLimit = (endSeconds - startSeconds) / 2;
    updateProject({
      musicTracks: project.musicTracks.map((item) =>
        item.id === id
          ? {
            ...item,
            startSeconds,
            endSeconds,
            fadeInSeconds: Math.min(item.fadeInSeconds, fadeLimit),
            fadeOutSeconds: Math.min(item.fadeOutSeconds, fadeLimit),
          }
          : item,
      ),
    });
  }

  function updateMusicTrack(id: string, patch: Partial<ShortMusicTrack>) {
    if (!project) return;
    updateProject({
      musicTracks: project.musicTracks.map((track) =>
        track.id === id ? { ...track, ...patch } : track,
      ),
    });
  }

  function updateOverlay(id: string, patch: Partial<ShortOverlay>) {
    if (!project) return;
    updateProject({
      overlays: project.overlays.map((overlay) =>
        overlay.id === id ? { ...overlay, ...patch } : overlay,
      ),
    });
  }

  function changeOverlayNumber(id: string, field: "startSeconds" | "endSeconds" | "left" | "top" | "width" | "height", value: string) {
    const overlay = project?.overlays.find((item) => item.id === id);
    const next = Number(value);
    if (!overlay || !Number.isFinite(next)) return;
    if (field === "startSeconds" && next >= overlay.endSeconds) {
      setError("An overlay must end after it starts.");
      return;
    }
    if (field === "endSeconds" && next <= overlay.startSeconds) {
      setError("An overlay must end after it starts.");
      return;
    }
    if (field === "left") updateOverlay(id, { left: Math.min(next, 100 - overlay.width) });
    else if (field === "top") updateOverlay(id, { top: Math.min(next, 100 - overlay.height) });
    else if (field === "width") updateOverlay(id, { width: Math.min(next, 100 - overlay.left) });
    else if (field === "height") updateOverlay(id, { height: Math.min(next, 100 - overlay.top) });
    else updateOverlay(id, { [field]: next });
    setError("");
  }

  function makeProject(video: Video, startSeconds: number, endSeconds: number, title: string): ShortProject {
    const projectSlug = `${slugify(video.title)}-${video.videoId.slice(0, 5).toLocaleLowerCase()}-${Date.now().toString(36)}`;
    return ShortProjectSchema.parse({
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
        keyframes: [{ timeSeconds: startSeconds, x: 50, y: 50, zoom: 1, fit: "cover" }],
      }],
      captions: filterCaptions(video, startSeconds, endSeconds),
      overlays: [],
      captionsEnabled: true,
      captionPosition: "bottom",
      captionSize: "medium",
      captionFontSize: 5.2,
      captionFontFamily: "sans",
      captionStyle: "bold-box",
      captionTextColor: "#ffffff",
      captionBackgroundColor: "#000000",
      captionBackgroundOpacity: 0.78,
      status: "draft",
      updatedAt: new Date().toISOString(),
    });
  }

  function createProject() {
    const video = videos.find((item) => item.videoId === selectedVideoId);
    if (!video || video.segments.length === 0) {
      setError("Choose a video with a saved timestamped transcript first.");
      return;
    }
    const startSeconds = video.sermonStartSeconds ?? video.segments[0].startSeconds;
    const endSeconds = Math.min(
      video.segments[video.segments.length - 1].endSeconds,
      startSeconds + 60,
      video.sermonEndSeconds ?? Number.POSITIVE_INFINITY,
    );
    if (endSeconds <= startSeconds) {
      setError("This transcript does not contain a usable clip range.");
      return;
    }
    setProject(makeProject(video, startSeconds, endSeconds, `${video.title} Short`));
    setLocalVideoUrl(null);
    localFileRef.current = null;
    setCurrentTime(startSeconds);
    setSuggestions([]);
    setSuggestionsVideoId("");
    setSuggestedBoundaries(null);
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
      if (parsed.data.sourceVideoId) setSelectedVideoId(parsed.data.sourceVideoId);
      setCurrentTime(parsed.data.startSeconds);
      setSuggestions([]);
      setSuggestionsVideoId("");
      setSuggestedBoundaries(null);
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
    if (!project || value.trim() === "") return;
    const nextValue = Number(value);
    const startSeconds = field === "startSeconds" ? nextValue : project.startSeconds;
    const endSeconds = field === "endSeconds" ? nextValue : project.endSeconds;
    if (!Number.isFinite(nextValue) || startSeconds < 0 || endSeconds <= startSeconds) {
      setError("Enter a valid start and end time; the end must be after the start.");
      return;
    }
    if (endSeconds - startSeconds > MAX_SHORT_DURATION_SECONDS) {
      setError("Shorts can be up to 3 minutes long.");
      return;
    }
    if (sourceVideoBounds && (
      startSeconds < sourceVideoBounds.start
      || endSeconds > sourceVideoBounds.end
    )) {
      setError("Keep the short inside the available transcript/video time range.");
      return;
    }
    const frameSlots = resizeFrameSlots(project.frameSlots, startSeconds, endSeconds);
    if (frameSlots.length === 0 || frameSlots.length > 100) {
      setError("The clip range could not be applied to its framing slots.");
      return;
    }
    const overlays = project.overlays.flatMap((overlay) => {
      const overlayStart = Math.max(startSeconds, overlay.startSeconds);
      const overlayEnd = Math.min(endSeconds, overlay.endSeconds);
      return overlayEnd > overlayStart
        ? [{ ...overlay, startSeconds: overlayStart, endSeconds: overlayEnd }]
        : [];
    });
    const brollClips = project.brollClips.flatMap((clip) => {
      const clipStart = Math.max(startSeconds, clip.startSeconds);
      const clipEnd = Math.min(endSeconds, clip.endSeconds);
      return clipEnd - clipStart >= 0.1
        ? [{ ...clip, startSeconds: clipStart, endSeconds: clipEnd }]
        : [];
    });
    const musicTracks = project.musicTracks.flatMap((track) => {
      const trackStart = Math.max(startSeconds, track.startSeconds);
      const trackEnd = Math.min(endSeconds, track.endSeconds);
      return trackEnd - trackStart >= 0.1
        ? [{ ...track, startSeconds: trackStart, endSeconds: trackEnd }]
        : [];
    });
    updateProject({
      [field]: nextValue,
      frameSlots,
      captions: filterCaptions(selectedVideo, startSeconds, endSeconds),
      overlays,
      brollClips,
      musicTracks,
    });
    setWebBrollSuggestions([]);
    setWebMusicSuggestions([]);
    setMediaSuggestionsProjectSlug("");
    setCurrentTime(startSeconds);
    if (
      overlays.length !== project.overlays.length
      || brollClips.length !== project.brollClips.length
      || musicTracks.length !== project.musicTracks.length
    ) {
      setNotice("Layers outside the new clip range were removed.");
    }
    setError("");
  }

  function setKeyframe(
    timeSeconds: number,
    x: number,
    y: number,
    zoom: number,
    fit?: ShortCropKeyframe["fit"],
  ) {
    if (!project) return;
    const index = project.frameSlots.findIndex((slot) =>
      timeSeconds >= slot.startSeconds && timeSeconds <= slot.endSeconds,
    );
    if (index < 0) return;
    const frame = {
      timeSeconds,
      x,
      y,
      zoom,
      fit: fit ?? getFramePosition(project.frameSlots[index], timeSeconds).fit,
    };
    const frameSlots = project.frameSlots.map((slot, slotIndex) => {
      if (slotIndex !== index) return slot;
      const keyframes = [
        ...slot.keyframes.filter((item) => item.timeSeconds < timeSeconds - 0.1),
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
      keyframes: [
        ...activeSlot.keyframes.filter((frame) => frame.timeSeconds < currentTime),
        { timeSeconds: currentTime, x: framePosition.x, y: framePosition.y, zoom: framePosition.zoom, fit: framePosition.fit },
      ],
    };
    const right = {
      ...activeSlot,
      startSeconds: currentTime,
      keyframes: [
        { timeSeconds: currentTime, x: framePosition.x, y: framePosition.y, zoom: framePosition.zoom, fit: framePosition.fit },
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
    setSuggestions([]);
    setSuggestionsVideoId("");
    setSuggestedBoundaries(null);
    try {
      const body = await requestJson("/api/ebook/shorts/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: selectedVideo.title,
          segments: selectedVideo.segments,
          instructions: agentInstructions,
        }),
      });
      const parsed = SuggestionResponseSchema.safeParse(body);
      if (!parsed.success) throw new Error("AI returned invalid short suggestions.");
      setSuggestions(parsed.data.suggestions);
      setSuggestionsVideoId(selectedVideo.videoId);
      setSuggestedBoundaries({
        videoStartSeconds: parsed.data.videoStartSeconds,
        videoEndSeconds: parsed.data.videoEndSeconds,
        sermonStartSeconds: parsed.data.sermonStartSeconds,
        sermonEndSeconds: parsed.data.sermonEndSeconds,
      });
      setNotice("AI reviewed transcript moments across the full video. Check the detected sermon boundaries and preview each clip.");
    } catch (suggestionError) {
      setError(suggestionError instanceof Error ? suggestionError.message : "Could not suggest short clips.");
    } finally {
      setBusy(false);
    }
  }

  function useSuggestion(suggestion: Suggestion) {
    const video = videos.find((item) => item.videoId === suggestionsVideoId);
    if (!video) {
      setError("Choose the source video for this AI suggestion first.");
      return;
    }
    try {
      setProject(makeProject(video, suggestion.startSeconds, suggestion.endSeconds, suggestion.title));
      setSelectedVideoId(video.videoId);
      setLocalVideoUrl(null);
      localFileRef.current = null;
      setCurrentTime(suggestion.startSeconds);
      setError("");
      setNotice("AI moment opened as a new draft. Adjust the clip, then save or publish it.");
      setScrollEditorOnUpdate(true);
    } catch (selectionError) {
      setError(selectionError instanceof Error ? selectionError.message : "Could not open this AI suggestion.");
    }
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

      <section className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900/40 p-4 sm:p-6">
        <label className="block text-sm font-medium text-slate-300">
          Select a saved transcript
          <select
            value={selectedVideoId}
            onChange={(event) => {
              setSelectedVideoId(event.target.value);
              setProject(null);
              setLocalVideoUrl(null);
              localFileRef.current = null;
              setSuggestions([]);
              setSuggestionsVideoId("");
              setSuggestedBoundaries(null);
              setError("");
              setNotice("");
            }}
            className="mt-2 min-h-12 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 text-base text-white focus:border-cyan-400 focus:outline-none"
          >
            <option value="">Choose a video…</option>
            {videos.filter((video) => video.segments.length > 0).map((video) => (
              <option key={video.videoId} value={video.videoId}>{video.title}</option>
            ))}
          </select>
        </label>
        <p className="text-sm leading-relaxed text-slate-400">
          Find AI moments analyzes the transcript and opens any selected moment directly in the editor. Start manual draft creates a basic 60-second draft without AI.
        </p>
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={addAiSuggestions}
            disabled={busy || !selectedVideo?.segments.length}
            className="min-h-12 rounded-xl bg-violet-500 px-5 text-sm font-bold text-white disabled:opacity-50"
          >
            {busy ? "Finding AI moments…" : "Find AI moments"}
          </button>
          <button
            type="button"
            onClick={createProject}
            disabled={busy || !selectedVideoId}
            className="min-h-12 rounded-xl border border-slate-600 px-5 text-sm font-semibold text-slate-200 disabled:opacity-50"
          >
            Start manual draft
          </button>
        </div>
      </section>

      <section className="space-y-3 rounded-2xl border border-violet-900/70 bg-violet-950/20 p-4 sm:p-6">
        <div>
          <h3 className="text-base font-semibold text-white">Reusable AI editor instructions</h3>
          <p className="mt-1 text-sm text-slate-400">
            These preferences are saved for every video and guide clip style without changing transcript evidence or timestamps.
          </p>
        </div>
        <textarea
          rows={3}
          maxLength={4000}
          value={agentInstructions}
          onChange={(event) => setAgentInstructions(event.target.value)}
          placeholder="For example: favor complete teaching points, keep the opening direct, and avoid clips that end during a prayer."
          className="min-h-24 w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-base text-white placeholder:text-slate-500"
        />
        <button
          type="button"
          onClick={() => void saveAgentInstructions()}
          disabled={busy}
          className="min-h-12 rounded-lg border border-violet-700 px-4 text-sm font-semibold text-violet-100 disabled:opacity-50"
        >
          Save reusable instructions
        </button>
      </section>

      {suggestions.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-lg font-semibold text-white">AI clip ideas</h3>
          {suggestedBoundaries && (
            <div className="grid gap-3 rounded-xl border border-amber-900/70 bg-amber-950/20 p-4 sm:grid-cols-2">
              <p className="text-sm text-slate-200">
                Main video transcript: {formatTime(suggestedBoundaries.videoStartSeconds)}–{formatTime(suggestedBoundaries.videoEndSeconds)}
              </p>
              <div className="space-y-2">
                <p className="text-sm text-amber-100">
                  AI sermon estimate: {suggestedBoundaries.sermonStartSeconds === null || suggestedBoundaries.sermonEndSeconds === null
                    ? "Could not confidently detect both boundaries."
                    : `${formatTime(suggestedBoundaries.sermonStartSeconds)}–${formatTime(suggestedBoundaries.sermonEndSeconds)}`}
                </p>
                {suggestedBoundaries.sermonStartSeconds !== null
                  && suggestedBoundaries.sermonEndSeconds !== null
                  && selectedVideo && (
                    <button
                      type="button"
                      onClick={() => void saveSermonBoundaries(
                        selectedVideo,
                        suggestedBoundaries.sermonStartSeconds,
                        suggestedBoundaries.sermonEndSeconds,
                      )}
                      disabled={busy}
                      className="min-h-12 rounded-lg border border-amber-800 px-3 text-xs font-semibold text-amber-100 disabled:opacity-50"
                    >
                      Save AI sermon boundaries to source video
                    </button>
                  )}
              </div>
            </div>
          )}
          <p className="text-sm text-slate-400">Tap a suggestion card to open and edit that clip.</p>
          <ul className="grid gap-3 lg:grid-cols-2">
            {suggestions.map((suggestion, index) => (
              <li key={`${suggestion.startSeconds}-${index}`}>
                <button
                  type="button"
                  onClick={() => useSuggestion(suggestion)}
                  disabled={busy || !suggestionsVideoId}
                  aria-label={`Edit ${suggestion.title} in Shorts Studio`}
                  className="block min-h-48 w-full cursor-pointer rounded-xl border border-cyan-700 bg-cyan-950/40 p-4 text-left text-white shadow-sm transition-colors hover:border-cyan-400 hover:bg-cyan-950/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 disabled:cursor-wait disabled:opacity-50"
                >
                  <span className="block font-semibold text-white">{suggestion.title}</span>
                  <span className="mt-2 block text-sm text-cyan-100">{suggestion.hook}</span>
                  <span className="mt-2 block text-xs leading-relaxed text-slate-300">{suggestion.reason}</span>
                  <span className="mt-2 block text-xs text-slate-300">{formatTime(suggestion.startSeconds)}–{formatTime(suggestion.endSeconds)}</span>
                  <span className="mt-3 inline-flex min-h-12 items-center rounded-lg bg-cyan-400 px-4 text-sm font-bold text-slate-950">
                    Edit this short
                  </span>
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
          <section
            ref={editorRef}
            className="fixed inset-0 z-[70] flex h-dvh flex-col gap-2 overflow-hidden bg-slate-950 p-2 pt-[max(env(safe-area-inset-top),0.5rem)] pb-[max(env(safe-area-inset-bottom),0.5rem)] sm:gap-3 sm:p-3 lg:pb-3"
          >
            <div className="flex shrink-0 flex-col gap-2 border-b border-slate-800 pb-2 sm:gap-3 sm:pb-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="min-w-0">
                <h3 className="truncate text-base font-bold text-white sm:text-lg">Editing: {project.title}</h3>
                <p className="mt-1 truncate text-xs text-slate-400">{project.status} · {formatTime(currentTime)} · frame {activeSlot?.aspectRatio ?? "9:16"}</p>
              </div>
              <div className="flex w-full shrink-0 gap-2 overflow-x-auto lg:w-auto">
                <button
                  type="button"
                  onClick={() => setProject(null)}
                  className="flex min-h-12 min-w-0 flex-1 items-center justify-center whitespace-nowrap rounded-xl border border-slate-700 px-2 text-xs font-semibold text-slate-200 sm:px-4 sm:text-sm lg:flex-none"
                >
                  <span className="sm:hidden">Close</span><span className="hidden sm:inline">Close editor</span>
                </button>
                <button type="button" onClick={saveDraft} disabled={busy} className="flex min-h-12 min-w-0 flex-1 items-center justify-center whitespace-nowrap rounded-xl border border-slate-700 px-2 text-xs font-semibold text-white disabled:opacity-50 sm:px-4 sm:text-sm lg:flex-none">
                  <span className="sm:hidden">Save</span><span className="hidden sm:inline">Save draft</span>
                </button>
                <button type="button" onClick={publishProject} disabled={busy} className="flex min-h-12 min-w-0 flex-1 items-center justify-center whitespace-nowrap rounded-xl bg-emerald-400 px-2 text-xs font-bold text-slate-950 disabled:opacity-50 sm:px-4 sm:text-sm lg:flex-none">
                  <span className="sm:hidden">{busy ? "…" : project.status === "published" ? "Update" : "Publish"}</span>
                  <span className="hidden sm:inline">{busy ? "Publishing…" : project.status === "published" ? "Update published short" : "Publish to Library"}</span>
                </button>
                {project.status === "published" && (
                  <button type="button" onClick={unpublishProject} disabled={busy} className="flex min-h-12 min-w-0 flex-1 items-center justify-center whitespace-nowrap rounded-xl border border-amber-800 px-2 text-xs font-semibold text-amber-200 disabled:opacity-50 sm:px-4 sm:text-sm lg:flex-none">
                    Unpublish
                  </button>
                )}
              </div>
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.82fr)] lg:grid-rows-1 lg:gap-3">
              <div className="flex h-[43dvh] shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/60 p-1.5 sm:h-[44dvh] sm:p-2 lg:h-auto lg:min-h-0 lg:shrink">
                <ShortsPlayer
                  project={project}
                  localVideoUrl={localVideoUrl}
                  editable
                  compactPreview
                  onTimeChange={setCurrentTime}
                  onCropChange={setKeyframe}
                />
              </div>

              <div className="min-h-0 flex-1 space-y-3 overflow-x-hidden overflow-y-auto overscroll-contain rounded-2xl border border-slate-800 bg-slate-900/60 p-3 [touch-action:pan-y] sm:p-4 lg:flex-none" style={{ WebkitOverflowScrolling: "touch" }}>
                <details open className="space-y-3 rounded-xl border border-slate-700 bg-slate-950/70 p-3">
                  <summary className="flex min-h-12 cursor-pointer items-center text-sm font-bold text-cyan-100">
                    Clip timing and framing
                  </summary>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block text-sm font-medium text-slate-300">
                    Start (seconds)
                    <input
                      type="number"
                      min={sourceVideoBounds?.start ?? 0}
                      max={Math.max(sourceVideoBounds?.start ?? 0, project.endSeconds - 0.1)}
                      step="0.1"
                      value={project.startSeconds}
                      onChange={(event) => updateRange("startSeconds", event.target.value)}
                      className="mt-2 min-h-12 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 text-base text-white disabled:opacity-50"
                    />
                  </label>
                  <label className="block text-sm font-medium text-slate-300">
                    End (seconds)
                    <input
                      type="number"
                      min={project.startSeconds + 0.1}
                      max={Math.min(
                        sourceVideoBounds?.end ?? project.startSeconds + MAX_SHORT_DURATION_SECONDS,
                        project.startSeconds + MAX_SHORT_DURATION_SECONDS,
                      )}
                      step="0.1"
                      value={project.endSeconds}
                      onChange={(event) => updateRange("endSeconds", event.target.value)}
                      className="mt-2 min-h-12 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 text-base text-white disabled:opacity-50"
                    />
                  </label>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block text-xs text-slate-400">
                    Trim start · {formatTime(project.startSeconds)}
                    <input
                      type="range"
                      min={sourceVideoBounds?.start ?? 0}
                      max={Math.max(sourceVideoBounds?.start ?? 0, project.endSeconds - 0.1)}
                      step="0.1"
                      value={project.startSeconds}
                      onChange={(event) => updateRange("startSeconds", event.target.value)}
                      className="min-h-12 w-full accent-cyan-400"
                    />
                  </label>
                  <label className="block text-xs text-slate-400">
                    Trim end · {formatTime(project.endSeconds)}
                    <input
                      type="range"
                      min={project.startSeconds + 0.1}
                      max={Math.max(
                        project.startSeconds + 0.1,
                        Math.min(
                          sourceVideoBounds?.end ?? project.startSeconds + MAX_SHORT_DURATION_SECONDS,
                          project.startSeconds + MAX_SHORT_DURATION_SECONDS,
                        ),
                      )}
                      step="0.1"
                      value={project.endSeconds}
                      onChange={(event) => updateRange("endSeconds", event.target.value)}
                      className="min-h-12 w-full accent-cyan-400"
                    />
                  </label>
                </div>
                <p className="text-xs text-slate-400">
                  Clip length: {formatTime(project.endSeconds - project.startSeconds)} · maximum 3:00
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => framePosition && setKeyframe(currentTime, framePosition.x, framePosition.y, framePosition.zoom, framePosition.fit)}
                    className="min-h-12 rounded-lg border border-slate-700 px-4 text-sm font-semibold text-slate-200"
                  >
                    Save position here
                  </button>
                  <button type="button" onClick={splitFrameSlot} disabled={busy || project.frameSlots.length >= 100} className="min-h-12 rounded-lg border border-cyan-800 px-4 text-sm font-semibold text-cyan-200 disabled:opacity-50">
                    Split framing slot
                  </button>
                </div>
                <p className="text-xs leading-relaxed text-slate-400">
                  Dragging saves a position at this time and holds it until you make another crop change. Use the playhead to add a later position.
                </p>
                </details>

              <details className="rounded-xl border border-slate-700 bg-slate-950/70 p-3">
                <summary className="flex min-h-12 cursor-pointer items-center text-sm font-bold text-cyan-100">
                  Short details and source
                </summary>
                <div className="mt-3 space-y-3">
                <div className="grid items-start gap-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
                  {project.thumbnailUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={project.thumbnailUrl}
                      alt="Current short thumbnail"
                      className="aspect-video w-full rounded-lg border border-slate-800 object-cover"
                    />
                  ) : (
                    <div className="flex aspect-video items-center justify-center rounded-lg border border-dashed border-slate-700 text-xs text-slate-500">
                      No custom thumbnail
                    </div>
                  )}
                  <div className="space-y-2">
                    <h4 className="text-sm font-semibold text-white">Short thumbnail</h4>
                    <p className="text-xs leading-relaxed text-slate-400">
                      Used on the public Shorts card and in link previews when a platform supports them. A wide image works well for link previews.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <label className="flex min-h-12 cursor-pointer items-center rounded-lg border border-cyan-800 px-3 text-sm font-semibold text-cyan-100">
                        {project.thumbnailUrl ? "Replace thumbnail" : "Upload thumbnail"}
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          disabled={busy}
                          onChange={(event) => {
                            void uploadThumbnail(event.target.files?.[0]);
                            event.target.value = "";
                          }}
                          className="sr-only"
                        />
                      </label>
                      {project.thumbnailUrl && (
                        <button
                          type="button"
                          onClick={() => updateProject({ thumbnailUrl: undefined })}
                          disabled={busy}
                          className="min-h-12 rounded-lg border border-slate-700 px-3 text-sm font-semibold text-slate-300 disabled:opacity-50"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                    <p className="text-xs text-slate-500">PNG, JPEG, or WebP · up to 10 MB</p>
                  </div>
                </div>
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
                {selectedVideo && sermonBoundaryDraft && (
                  <div className="space-y-3 rounded-xl border border-amber-900/70 bg-amber-950/15 p-3">
                    <div>
                      <h4 className="text-sm font-semibold text-white">Source video and sermon boundaries</h4>
                      {sourceVideoBounds && (
                        <p className="mt-1 text-xs text-slate-400">
                          Transcript bounds: {formatTime(sourceVideoBounds.start)}–{formatTime(sourceVideoBounds.end)}
                        </p>
                      )}
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="block text-sm text-slate-300">
                        Sermon starts (seconds)
                        <input
                          type="number"
                          min={sourceVideoBounds?.start ?? 0}
                          max={sourceVideoBounds?.end}
                          step="0.1"
                          value={sermonBoundaryDraft.start}
                          onChange={(event) => setSermonBoundaryDrafts((current) => ({
                            ...current,
                            [selectedVideo.videoId]: { ...sermonBoundaryDraft, start: event.target.value },
                          }))}
                          className="mt-2 min-h-12 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-base text-white"
                        />
                      </label>
                      <label className="block text-sm text-slate-300">
                        Sermon ends (seconds)
                        <input
                          type="number"
                          min={sourceVideoBounds?.start ?? 0}
                          max={sourceVideoBounds?.end}
                          step="0.1"
                          value={sermonBoundaryDraft.end}
                          onChange={(event) => setSermonBoundaryDrafts((current) => ({
                            ...current,
                            [selectedVideo.videoId]: { ...sermonBoundaryDraft, end: event.target.value },
                          }))}
                          className="mt-2 min-h-12 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-base text-white"
                        />
                      </label>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        const start = sermonBoundaryDraft.start.trim() ? Number(sermonBoundaryDraft.start) : null;
                        const end = sermonBoundaryDraft.end.trim() ? Number(sermonBoundaryDraft.end) : null;
                        if (
                          (start !== null && !Number.isFinite(start))
                          || (end !== null && !Number.isFinite(end))
                        ) {
                          setError("Enter valid numeric sermon times.");
                          return;
                        }
                        void saveSermonBoundaries(selectedVideo, start, end);
                      }}
                      disabled={busy}
                      className="min-h-12 rounded-lg border border-amber-800 px-4 text-sm font-semibold text-amber-100 disabled:opacity-50"
                    >
                      Save sermon boundaries
                    </button>
                  </div>
                )}
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
                </div>
              </details>
              <details className="rounded-xl border border-slate-700 bg-slate-950/70 p-3">
                <summary className="flex min-h-12 cursor-pointer items-center text-sm font-bold text-cyan-100">
                  B-roll and instrumental music
                </summary>
                <div className="mt-3 space-y-4">
                  <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <h4 className="text-sm font-semibold text-white">B-roll cutaways</h4>
                        <p className="mt-1 text-xs leading-relaxed text-slate-400">
                          AI searches Pexels using this short&apos;s transcript and suggests when each cutaway fits. Selected web clips play over the YouTube picture while sermon audio continues.
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => void findWebMedia("broll")}
                          disabled={busy || mediaSearchKind !== null || project.captions.length === 0 || project.brollClips.length >= 10}
                          className="min-h-12 rounded-lg bg-cyan-500 px-4 text-xs font-bold text-slate-950 disabled:opacity-50"
                        >
                          {mediaSearchKind === "broll" ? "Finding web B-roll…" : "Find web B-roll with AI"}
                        </button>
                        <label className="flex min-h-12 cursor-pointer items-center rounded-lg border border-cyan-800 px-3 text-xs font-semibold text-cyan-100">
                          Upload my own
                          <input
                            type="file"
                            accept="video/mp4,video/webm,.mp4,.webm"
                            disabled={busy || project.brollClips.length >= 10}
                            onChange={(event) => {
                              void addBrollClip(event.target.files?.[0]);
                              event.target.value = "";
                            }}
                            className="sr-only"
                          />
                        </label>
                      </div>
                    </div>
                    {mediaSuggestionsProjectSlug === project.slug && webBrollSuggestions.length > 0 && (
                      <ul className="grid gap-3 sm:grid-cols-2">
                        {webBrollSuggestions.map((suggestion) => (
                          <li key={suggestion.id} className="min-w-0 space-y-3 rounded-lg border border-cyan-900/70 bg-slate-900 p-3">
                            <video
                              src={suggestion.videoUrl}
                              poster={suggestion.previewUrl}
                              muted
                              playsInline
                              controls
                              preload="none"
                              aria-label={`Preview ${suggestion.title}`}
                              className="aspect-video w-full rounded-lg bg-black object-cover"
                            />
                            <div>
                              <p className="text-sm font-semibold text-white">{suggestion.title}</p>
                              <p className="mt-1 text-xs text-cyan-200">
                                Suggested {formatTime(suggestion.startSeconds)}–{formatTime(suggestion.endSeconds)}
                              </p>
                              <p className="mt-1 text-xs leading-relaxed text-slate-300">{suggestion.reason}</p>
                              <p className="mt-1 text-xs text-slate-400">Search: {suggestion.query}</p>
                            </div>
                            <p className="text-xs leading-relaxed text-slate-400">
                              Video by{" "}
                              <a href={suggestion.creatorUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                                {suggestion.creatorName}
                              </a>
                              {" · "}
                              <a href={suggestion.providerPageUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                                Pexels source
                              </a>
                              {" · "}
                              <a href={suggestion.licenseUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                                license
                              </a>
                            </p>
                            <button
                              type="button"
                              onClick={() => addWebBroll(suggestion)}
                              disabled={project.brollClips.length >= 10}
                              className="min-h-12 w-full rounded-lg border border-cyan-700 px-3 text-sm font-semibold text-cyan-100 disabled:opacity-50"
                            >
                              Add to timeline
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    {project.brollClips.length === 0 ? (
                      <p className="text-xs text-slate-500">No B-roll clips on the timeline yet. Web results are added only when you choose them.</p>
                    ) : (
                      <ul className="space-y-3">
                        {project.brollClips.map((clip, index) => (
                          <li key={clip.id} className="space-y-3 rounded-lg border border-slate-800 bg-slate-900 p-3">
                            <div className="flex items-center justify-between gap-2">
                              <div className="min-w-0">
                                <p className="truncate text-sm font-semibold text-white">B-roll {index + 1}</p>
                                <p className="truncate text-xs text-slate-400">{clip.fileName} · {formatTime(clip.sourceDurationSeconds)}</p>
                                {clip.creatorName && clip.providerPageUrl && (
                                  <a href={clip.providerPageUrl} target="_blank" rel="noreferrer" className="text-xs text-cyan-300 underline underline-offset-2">
                                    {clip.creatorName} · {clip.provider === "pexels" ? "Pexels" : "Uploaded"}
                                  </a>
                                )}
                              </div>
                              <button
                                type="button"
                                onClick={() => updateProject({
                                  brollClips: project.brollClips.filter((item) => item.id !== clip.id),
                                })}
                                className="min-h-12 min-w-12 rounded-lg border border-rose-900 px-3 text-xs font-semibold text-rose-200"
                              >
                                Remove
                              </button>
                            </div>
                            <div className="grid gap-3 sm:grid-cols-2">
                              <label className="block text-xs text-slate-400">
                                Show from
                                <input
                                  type="number"
                                  min={project.startSeconds}
                                  max={clip.endSeconds - 0.1}
                                  step="0.1"
                                  value={clip.startSeconds}
                                  onChange={(event) => changeBrollRange(clip.id, "startSeconds", event.target.value)}
                                  className="mt-1 min-h-12 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-base text-white"
                                />
                              </label>
                              <label className="block text-xs text-slate-400">
                                Show until
                                <input
                                  type="number"
                                  min={clip.startSeconds + 0.1}
                                  max={Math.min(project.endSeconds, clip.startSeconds + clip.sourceDurationSeconds)}
                                  step="0.1"
                                  value={clip.endSeconds}
                                  onChange={(event) => changeBrollRange(clip.id, "endSeconds", event.target.value)}
                                  className="mt-1 min-h-12 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-base text-white"
                                />
                              </label>
                              <label className="block text-xs text-slate-400 sm:col-span-2">
                                B-roll fit
                                <select
                                  value={clip.fit}
                                  onChange={(event) => updateProject({
                                    brollClips: project.brollClips.map((item) =>
                                      item.id === clip.id ? { ...item, fit: event.target.value as ShortBrollClip["fit"] } : item,
                                    ),
                                  })}
                                  className="mt-1 min-h-12 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-base text-white"
                                >
                                  <option value="cover">Fill the frame</option>
                                  <option value="contain">Show full B-roll frame</option>
                                </select>
                              </label>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>

                  <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <h4 className="text-sm font-semibold text-white">Instrumental bed</h4>
                        <p className="mt-1 text-xs leading-relaxed text-slate-400">
                          AI searches Jamendo&apos;s commercial single-track catalog for transcript-matched instrumental music. Preview a result and add it to the editable timeline.
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => void findWebMedia("music")}
                          disabled={busy || mediaSearchKind !== null || project.captions.length === 0 || project.musicTracks.length >= 5}
                          className="min-h-12 rounded-lg bg-violet-400 px-4 text-xs font-bold text-slate-950 disabled:opacity-50"
                        >
                          {mediaSearchKind === "music" ? "Finding instrumental…" : "Find music with AI"}
                        </button>
                        <label className="flex min-h-12 cursor-pointer items-center rounded-lg border border-violet-800 px-3 text-xs font-semibold text-violet-100">
                          Upload my own
                          <input
                            type="file"
                            accept="audio/mpeg,audio/mp4,audio/aac,audio/wav,audio/x-wav,.mp3,.m4a,.aac,.wav"
                            disabled={busy || project.musicTracks.length >= 5}
                            onChange={(event) => {
                              void addMusicTrack(event.target.files?.[0]);
                              event.target.value = "";
                            }}
                            className="sr-only"
                          />
                        </label>
                      </div>
                    </div>
                    {mediaSuggestionsProjectSlug === project.slug && webMusicSuggestions.length > 0 && (
                      <ul className="grid gap-3 sm:grid-cols-2">
                        {webMusicSuggestions.map((suggestion) => (
                          <li key={suggestion.id} className="min-w-0 space-y-3 rounded-lg border border-violet-900/70 bg-slate-900 p-3">
                            <div>
                              <p className="text-sm font-semibold text-white">{suggestion.title}</p>
                              <p className="text-xs text-violet-200">{suggestion.artistName} · {formatTime(suggestion.durationSeconds)}</p>
                              <p className="mt-1 text-xs leading-relaxed text-slate-300">{suggestion.reason}</p>
                              <p className="mt-1 text-xs text-slate-400">Search: {suggestion.query}</p>
                            </div>
                            <audio
                              src={suggestion.audioUrl}
                              controls
                              preload="none"
                              aria-label={`Preview ${suggestion.title} by ${suggestion.artistName}`}
                              className="w-full"
                            />
                            <p className="text-xs leading-relaxed text-slate-400">
                              By{" "}
                              <a href={suggestion.creatorUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                                {suggestion.artistName}
                              </a>
                              {" · "}
                              <a href={suggestion.providerPageUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                                Jamendo track
                              </a>
                              {" · "}
                              <a href={suggestion.licenseUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                                commercial license
                              </a>
                            </p>
                            <button
                              type="button"
                              onClick={() => addWebMusic(suggestion)}
                              disabled={project.musicTracks.length >= 5}
                              className="min-h-12 w-full rounded-lg border border-violet-700 px-3 text-sm font-semibold text-violet-100 disabled:opacity-50"
                            >
                              Add to timeline
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    {project.musicTracks.length === 0 ? (
                      <p className="text-xs text-slate-500">No instrumental tracks on the timeline yet.</p>
                    ) : (
                      <ul className="space-y-3">
                        {project.musicTracks.map((track, index) => (
                          <li key={track.id} className="space-y-3 rounded-lg border border-slate-800 bg-slate-900 p-3">
                            <div className="flex items-center justify-between gap-2">
                              <div className="min-w-0">
                                <p className="truncate text-sm font-semibold text-white">Instrumental {index + 1}</p>
                                <p className="truncate text-xs text-slate-400">{track.fileName} · {formatTime(track.sourceDurationSeconds)}</p>
                                {track.creatorName && track.providerPageUrl && (
                                  <a href={track.providerPageUrl} target="_blank" rel="noreferrer" className="text-xs text-violet-300 underline underline-offset-2">
                                    {track.creatorName} · {track.provider === "jamendo" ? "Jamendo" : "Uploaded"}
                                  </a>
                                )}
                              </div>
                              <button
                                type="button"
                                onClick={() => updateProject({
                                  musicTracks: project.musicTracks.filter((item) => item.id !== track.id),
                                })}
                                className="min-h-12 min-w-12 rounded-lg border border-rose-900 px-3 text-xs font-semibold text-rose-200"
                              >
                                Remove
                              </button>
                            </div>
                            {track.provider === "jamendo" && (
                              <>
                                {!track.commercialLicenseConfirmed && (
                                  <p className="text-xs leading-relaxed text-amber-200">
                                    Publishing is blocked until you obtain the Jamendo commercial license and confirm it below.
                                  </p>
                                )}
                                <label className="flex min-h-12 items-center gap-3 rounded-lg border border-amber-900/70 bg-amber-950/20 px-3 text-xs leading-relaxed text-amber-100">
                                  <input
                                    type="checkbox"
                                    checked={track.commercialLicenseConfirmed}
                                    onChange={(event) => updateMusicTrack(track.id, {
                                      commercialLicenseConfirmed: event.target.checked,
                                    })}
                                    className="min-h-12 min-w-12 accent-amber-400"
                                  />
                                  I have obtained the Jamendo commercial license for public use of this track.
                                </label>
                              </>
                            )}
                            <div className="grid gap-3 sm:grid-cols-2">
                              <label className="block text-xs text-slate-400">
                                Start at
                                <input
                                  type="number"
                                  min={project.startSeconds}
                                  max={track.endSeconds - 0.1}
                                  step="0.1"
                                  value={track.startSeconds}
                                  onChange={(event) => changeMusicRange(track.id, "startSeconds", event.target.value)}
                                  className="mt-1 min-h-12 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-base text-white"
                                />
                              </label>
                              <label className="block text-xs text-slate-400">
                                End at
                                <input
                                  type="number"
                                  min={track.startSeconds + 0.1}
                                  max={Math.min(project.endSeconds, track.startSeconds + track.sourceDurationSeconds)}
                                  step="0.1"
                                  value={track.endSeconds}
                                  onChange={(event) => changeMusicRange(track.id, "endSeconds", event.target.value)}
                                  className="mt-1 min-h-12 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-base text-white"
                                />
                              </label>
                            </div>
                            <label className="block text-xs text-slate-400">
                              Music level · {Math.round(track.volume * 100)}%
                              <input
                                type="range"
                                min="0"
                                max="1"
                                step="0.01"
                                value={track.volume}
                                onChange={(event) => updateMusicTrack(track.id, { volume: Number(event.target.value) })}
                                className="min-h-12 w-full accent-violet-400"
                              />
                            </label>
                            <div className="grid gap-3 sm:grid-cols-2">
                              <label className="block text-xs text-slate-400">
                                Fade in · {track.fadeInSeconds.toFixed(1)} sec
                                <input
                                  type="range"
                                  min="0"
                                  max={Math.min(10, (track.endSeconds - track.startSeconds) / 2)}
                                  step="0.1"
                                  value={Math.min(track.fadeInSeconds, (track.endSeconds - track.startSeconds) / 2)}
                                  onChange={(event) => updateMusicTrack(track.id, { fadeInSeconds: Number(event.target.value) })}
                                  className="min-h-12 w-full accent-violet-400"
                                />
                              </label>
                              <label className="block text-xs text-slate-400">
                                Fade out · {track.fadeOutSeconds.toFixed(1)} sec
                                <input
                                  type="range"
                                  min="0"
                                  max={Math.min(10, (track.endSeconds - track.startSeconds) / 2)}
                                  step="0.1"
                                  value={Math.min(track.fadeOutSeconds, (track.endSeconds - track.startSeconds) / 2)}
                                  onChange={(event) => updateMusicTrack(track.id, { fadeOutSeconds: Number(event.target.value) })}
                                  className="min-h-12 w-full accent-violet-400"
                                />
                              </label>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                  <p className="text-xs leading-relaxed text-amber-200">
                    Web B-roll and music stream from their providers rather than being copied into storage. Jamendo requires commercial/API approval and a confirmed license for every track. A downloadable, merged video still requires an authorized source upload.
                  </p>
                </div>
              </details>
              <details open className="rounded-xl border border-slate-700 bg-slate-950/70 p-3">
                <summary className="flex min-h-12 cursor-pointer items-center text-sm font-bold text-cyan-100">
                  Framing and crop
                </summary>
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
                    </div>
                    <div className="space-y-2">
                      <p className="text-sm text-slate-300">Video fit inside this frame</p>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          aria-pressed={framePosition.fit === "contain"}
                          onClick={() => setKeyframe(currentTime, framePosition.x, framePosition.y, framePosition.zoom, "contain")}
                          className={`min-h-12 rounded-lg border px-3 text-sm font-semibold ${
                            framePosition.fit === "contain"
                              ? "border-cyan-400 bg-cyan-950 text-cyan-100"
                              : "border-slate-700 text-slate-300"
                          }`}
                        >
                          Show full 16:9
                        </button>
                        <button
                          type="button"
                          aria-pressed={framePosition.fit === "cover"}
                          onClick={() => setKeyframe(currentTime, framePosition.x, framePosition.y, framePosition.zoom, "cover")}
                          className={`min-h-12 rounded-lg border px-3 text-sm font-semibold ${
                            framePosition.fit === "cover"
                              ? "border-cyan-400 bg-cyan-950 text-cyan-100"
                              : "border-slate-700 text-slate-300"
                          }`}
                        >
                          Fill 9:16
                        </button>
                        <button
                          type="button"
                          onClick={() => setKeyframe(currentTime, 50, 50, 1, framePosition.fit)}
                          className="min-h-12 rounded-lg border border-slate-700 px-3 text-sm font-semibold text-slate-300"
                        >
                          Reset position
                        </button>
                      </div>
                      <p className="text-xs text-slate-500">
                        Fit changes are saved at the playhead and remain until another framing change.
                      </p>
                    </div>
                    {(["x", "y", "zoom"] as const).map((axis) => (
                      <label key={axis} className="block text-sm text-slate-300">
                        {axis === "x" ? "Horizontal position" : axis === "y" ? "Vertical position" : "Scale video in frame"} · {axis === "zoom" ? `${framePosition[axis].toFixed(2)}×` : `${Math.round(framePosition[axis])}%`}
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
              </details>
              <details className="rounded-xl border border-slate-700 bg-slate-950/70 p-3">
                <summary className="flex min-h-12 cursor-pointer items-center text-sm font-bold text-cyan-100">
                  Captions
                </summary>
                <div className="mt-3">
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
                      Caption style
                      <select value={project.captionStyle} onChange={(event) => updateProject({ captionStyle: event.target.value as ShortProject["captionStyle"] })} className="mt-2 min-h-12 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-base text-white">
                        <option value="bold-box">Bold box</option>
                        <option value="clean">Clean</option>
                        <option value="outline">Outlined</option>
                        <option value="pill">Pill</option>
                        <option value="minimal">Minimal</option>
                      </select>
                    </label>
                    <label className="block text-sm text-slate-300">
                      Font
                      <select value={project.captionFontFamily} onChange={(event) => updateProject({ captionFontFamily: event.target.value as ShortProject["captionFontFamily"] })} className="mt-2 min-h-12 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-base text-white">
                        <option value="sans">Modern sans</option>
                        <option value="condensed">Condensed</option>
                        <option value="rounded">Rounded</option>
                        <option value="serif">Serif</option>
                      </select>
                    </label>
                    <label className="block text-sm text-slate-300">
                      Text color
                      <input
                        type="color"
                        value={project.captionTextColor}
                        onChange={(event) => updateProject({ captionTextColor: event.target.value })}
                        className="mt-2 h-12 w-full rounded-lg border border-slate-700 bg-slate-900 p-1"
                      />
                    </label>
                    {["bold-box", "pill"].includes(project.captionStyle) && (
                      <>
                        <label className="block text-sm text-slate-300">
                          Background fill
                          <select
                            value={project.captionBackgroundColor === "transparent" ? "transparent" : "color"}
                            onChange={(event) => updateProject({
                              captionBackgroundColor: event.target.value === "transparent"
                                ? "transparent"
                                : project.captionBackgroundColor === "transparent" ? "#000000" : project.captionBackgroundColor,
                            })}
                            className="mt-2 min-h-12 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-base text-white"
                          >
                            <option value="color">Solid color</option>
                            <option value="transparent">No fill</option>
                          </select>
                        </label>
                        {project.captionBackgroundColor !== "transparent" && (
                          <label className="block text-sm text-slate-300">
                            Background color
                            <input
                              type="color"
                              value={project.captionBackgroundColor}
                              onChange={(event) => updateProject({ captionBackgroundColor: event.target.value })}
                              className="mt-2 h-12 w-full rounded-lg border border-slate-700 bg-slate-900 p-1"
                            />
                          </label>
                        )}
                      </>
                    )}
                  </div>
                  <label className="block text-sm text-slate-300">
                    Font size · {Math.round(((project.captionFontSize ?? (
                      project.captionSize === "small" ? 4.4 : project.captionSize === "large" ? 6.2 : 5.2
                    )) / 5.2) * 100)}%
                    <input
                      type="range"
                      min="3.5"
                      max="8"
                      step="0.1"
                      value={project.captionFontSize ?? (
                        project.captionSize === "small" ? 4.4 : project.captionSize === "large" ? 6.2 : 5.2
                      )}
                      onChange={(event) => updateProject({ captionFontSize: Number(event.target.value) })}
                      aria-label="Subtitle font size"
                      className="min-h-12 w-full accent-cyan-400"
                    />
                  </label>
                  {["bold-box", "pill"].includes(project.captionStyle) && project.captionBackgroundColor !== "transparent" && (
                    <label className="block text-sm text-slate-300">
                      Background opacity · {Math.round(project.captionBackgroundOpacity * 100)}%
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.05"
                        value={project.captionBackgroundOpacity}
                        onChange={(event) => updateProject({ captionBackgroundOpacity: Number(event.target.value) })}
                        className="min-h-12 w-full accent-cyan-400"
                      />
                    </label>
                  )}
                  <p className="text-xs leading-relaxed text-slate-500">
                    Long transcript timestamps are split into timed phrases. Captions are capped at two lines on screen. Background controls apply to Bold box and Pill styles.
                  </p>
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
              </details>
              <details className="rounded-xl border border-slate-700 bg-slate-950/70 p-3">
                <summary className="flex min-h-12 cursor-pointer items-center text-sm font-bold text-cyan-100">
                  Frames and overlays
                </summary>
                <div className="mt-3">
                <div className="space-y-3 rounded-xl border border-fuchsia-900/70 bg-fuchsia-950/10 p-3">
                  <div>
                    <h4 className="text-sm font-semibold text-white">Frames and overlay layers</h4>
                    <p className="mt-1 text-xs leading-relaxed text-slate-400">
                      Add text, an image/logo, or a transparent PNG frame. Set each layer’s timing and position in the short.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={addTextOverlay}
                      disabled={busy || project.overlays.length >= 20}
                      className="min-h-12 rounded-lg border border-fuchsia-800 px-3 text-xs font-semibold text-fuchsia-100 disabled:opacity-50"
                    >
                      Add text overlay
                    </button>
                    <label className="flex min-h-12 cursor-pointer items-center rounded-lg border border-slate-700 px-3 text-xs font-semibold text-slate-200">
                      Add image/logo
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        disabled={busy || project.overlays.length >= 20}
                        onChange={(event) => {
                          void uploadOverlay(event.target.files?.[0], "image");
                          event.target.value = "";
                        }}
                        className="sr-only"
                      />
                    </label>
                    <label className="flex min-h-12 cursor-pointer items-center rounded-lg border border-slate-700 px-3 text-xs font-semibold text-slate-200">
                      Add transparent frame
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        disabled={busy || project.overlays.length >= 20}
                        onChange={(event) => {
                          void uploadOverlay(event.target.files?.[0], "frame");
                          event.target.value = "";
                        }}
                        className="sr-only"
                      />
                    </label>
                  </div>
                  <label className="block text-xs text-slate-400">
                    Describe a modern overlay preset
                    <textarea
                      rows={2}
                      maxLength={1000}
                      value={overlayBrief}
                      onChange={(event) => setOverlayBrief(event.target.value)}
                      placeholder="e.g. refined charcoal and gold sermon title, minimal lower-third, subtle corner frame"
                      className="mt-1 min-h-12 w-full rounded-lg border border-slate-700 bg-slate-900 p-3 text-base text-white placeholder:text-slate-500"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => void generateOverlayPreset()}
                    disabled={busy || !overlayBrief.trim() || overlayPresets.length >= 20}
                    className="min-h-12 rounded-lg bg-fuchsia-500 px-4 text-sm font-bold text-white disabled:opacity-50"
                  >
                    {busy ? "Generating overlay preset…" : "Generate & apply AI preset"}
                  </button>
                  {overlayPresets.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs font-semibold text-slate-300">Reusable presets · {overlayPresets.length}/20</p>
                      <ul className="grid gap-2 sm:grid-cols-2">
                        {overlayPresets.map((preset) => (
                          <li key={preset.id} className="rounded-lg border border-slate-800 bg-slate-900 p-3">
                            <h5 className="text-sm font-semibold text-white">{preset.name}</h5>
                            <p className="mt-1 text-xs leading-relaxed text-slate-400">{preset.description}</p>
                            <div className="mt-2 flex flex-wrap gap-2">
                              <button
                                type="button"
                                onClick={() => applyOverlayPreset(preset)}
                                disabled={busy || project.overlays.length + preset.layers.length > 20}
                                className="min-h-12 rounded-lg border border-fuchsia-700 px-3 text-xs font-semibold text-fuchsia-100 disabled:opacity-50"
                              >
                                Apply preset
                              </button>
                              <button
                                type="button"
                                onClick={() => void removeOverlayPreset(preset.id)}
                                disabled={busy}
                                className="min-h-12 rounded-lg border border-slate-700 px-3 text-xs font-semibold text-slate-300 disabled:opacity-50"
                              >
                                Remove preset
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {project.overlays.length === 0 ? (
                    <p className="text-xs text-slate-500">No overlays added yet. Image uploads are stored for use in published shorts.</p>
                  ) : (
                    <ul className="space-y-3">
                      {project.overlays.map((overlay, index) => (
                        <li key={overlay.id} className="space-y-3 rounded-lg border border-slate-800 bg-slate-950/70 p-3">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-semibold uppercase text-slate-200">
                              {overlay.type === "frame" ? "Frame" : overlay.type === "image" ? "Image / logo" : "Text"} {index + 1}
                            </span>
                            <button
                              type="button"
                              onClick={() => updateProject({
                                overlays: project.overlays.filter((item) => item.id !== overlay.id),
                              })}
                              className="min-h-12 min-w-12 rounded-lg border border-rose-900 px-3 text-xs font-semibold text-rose-200"
                            >
                              Remove
                            </button>
                          </div>
                          <div className="space-y-2">
                            <p className="text-xs text-slate-400">
                              Layer order · {overlay.zIndex < 50 ? "behind subtitles" : "in front of subtitles"}
                            </p>
                            <div className="flex flex-wrap gap-2">
                              <button
                                type="button"
                                onClick={() => updateOverlay(overlay.id, { zIndex: 0 })}
                                disabled={overlay.zIndex === 0}
                                className="min-h-12 rounded-lg border border-slate-700 px-3 text-xs font-semibold text-slate-200 disabled:opacity-40"
                              >
                                Send to back
                              </button>
                              <button
                                type="button"
                                onClick={() => updateOverlay(overlay.id, { zIndex: 40 })}
                                disabled={overlay.zIndex === 40}
                                className="min-h-12 rounded-lg border border-cyan-900 px-3 text-xs font-semibold text-cyan-100 disabled:opacity-40"
                              >
                                Behind subtitles
                              </button>
                              <button
                                type="button"
                                onClick={() => updateOverlay(overlay.id, { zIndex: Math.min(100, overlay.zIndex + 5) })}
                                disabled={overlay.zIndex === 100}
                                className="min-h-12 rounded-lg border border-slate-700 px-3 text-xs font-semibold text-slate-200 disabled:opacity-40"
                              >
                                Bring forward
                              </button>
                              <button
                                type="button"
                                onClick={() => updateOverlay(overlay.id, { zIndex: 100 })}
                                disabled={overlay.zIndex === 100}
                                className="min-h-12 rounded-lg border border-cyan-900 px-3 text-xs font-semibold text-cyan-100 disabled:opacity-40"
                              >
                                Above subtitles
                              </button>
                            </div>
                          </div>
                          {overlay.type === "text" && (
                            <>
                              <textarea
                                rows={2}
                                maxLength={300}
                                value={overlay.text ?? ""}
                                onChange={(event) => updateOverlay(overlay.id, { text: event.target.value })}
                                aria-label={`Overlay ${index + 1} text`}
                                className="min-h-12 w-full rounded-lg border border-slate-700 bg-slate-900 p-2 text-base text-white"
                              />
                              <div className="grid gap-3 sm:grid-cols-3">
                                <label className="text-xs text-slate-400">
                                  Text color
                                  <input
                                    type="color"
                                    value={overlay.textColor}
                                    onChange={(event) => updateOverlay(overlay.id, { textColor: event.target.value })}
                                    className="mt-1 h-12 w-full rounded-lg border border-slate-700 bg-slate-900 p-1"
                                  />
                                </label>
                                <label className="text-xs text-slate-400">
                                  Color fill
                                  <select
                                    value={overlay.backgroundColor === "transparent" ? "transparent" : "solid"}
                                    onChange={(event) => updateOverlay(overlay.id, {
                                      backgroundColor: event.target.value === "transparent"
                                        ? "transparent"
                                        : overlay.backgroundColor === "transparent" ? "#111827" : overlay.backgroundColor,
                                    })}
                                    className="mt-1 min-h-12 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-base text-white"
                                  >
                                    <option value="solid">Solid color</option>
                                    <option value="transparent">No fill</option>
                                  </select>
                                </label>
                                <label className="text-xs text-slate-400">
                                  Font size
                                  <input
                                    type="number"
                                    min="8"
                                    max="96"
                                    value={overlay.fontSize}
                                    onChange={(event) => {
                                      const size = Number(event.target.value);
                                      if (Number.isFinite(size)) updateOverlay(overlay.id, { fontSize: Math.max(8, Math.min(96, size)) });
                                    }}
                                    className="mt-1 min-h-12 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-base text-white"
                                  />
                                </label>
                                {overlay.backgroundColor !== "transparent" && (
                                  <label className="text-xs text-slate-400">
                                    Fill color
                                    <input
                                      type="color"
                                      value={overlay.backgroundColor}
                                      onChange={(event) => updateOverlay(overlay.id, { backgroundColor: event.target.value })}
                                      className="mt-1 h-12 w-full rounded-lg border border-slate-700 bg-slate-900 p-1"
                                    />
                                  </label>
                                )}
                              </div>
                            </>
                          )}
                          {overlay.type === "frame" && !overlay.imageUrl && (
                            <label className="block text-xs text-slate-400">
                              Frame style
                              <select
                                value={overlay.frameStyle ?? "outline"}
                                onChange={(event) => updateOverlay(overlay.id, {
                                  frameStyle: event.target.value as ShortOverlay["frameStyle"],
                                })}
                                className="mt-1 min-h-12 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-base text-white"
                              >
                                <option value="outline">Fine outline</option>
                                <option value="corner-brackets">Corner brackets</option>
                                <option value="neon">Soft neon</option>
                              </select>
                            </label>
                          )}
                          <div className="grid gap-3 sm:grid-cols-3">
                            <label className="text-xs text-slate-400">
                              Accent / border color
                              <input
                                type="color"
                                value={overlay.borderColor}
                                onChange={(event) => updateOverlay(overlay.id, { borderColor: event.target.value })}
                                className="mt-1 h-12 w-full rounded-lg border border-slate-700 bg-slate-900 p-1"
                              />
                            </label>
                            <label className="text-xs text-slate-400">
                              Border width
                              <input
                                type="number"
                                min="0"
                                max="12"
                                step="1"
                                value={overlay.borderWidth}
                                onChange={(event) => {
                                  const width = Number(event.target.value);
                                  if (Number.isFinite(width)) updateOverlay(overlay.id, { borderWidth: Math.max(0, Math.min(12, width)) });
                                }}
                                className="mt-1 min-h-12 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-base text-white"
                              />
                            </label>
                            <label className="text-xs text-slate-400">
                              Corner radius
                              <input
                                type="number"
                                min="0"
                                max="100"
                                step="1"
                                value={overlay.borderRadius}
                                onChange={(event) => {
                                  const radius = Number(event.target.value);
                                  if (Number.isFinite(radius)) updateOverlay(overlay.id, { borderRadius: Math.max(0, Math.min(100, radius)) });
                                }}
                                className="mt-1 min-h-12 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-base text-white"
                              />
                            </label>
                          </div>
                          <div className="grid gap-2 sm:grid-cols-2">
                            {([
                              ["startSeconds", "Show from (seconds)", project.startSeconds, project.endSeconds],
                              ["endSeconds", "Show until (seconds)", project.startSeconds, project.endSeconds],
                              ["left", "Left (%)", 0, 100],
                              ["top", "Top (%)", 0, 100],
                              ["width", "Width (%)", 1, 100],
                              ["height", "Height (%)", 1, 100],
                            ] as const).map(([field, label, min, max]) => (
                              <label key={field} className="text-xs text-slate-400">
                                {label}
                                <input
                                  type="number"
                                  min={min}
                                  max={max}
                                  step="0.1"
                                  value={overlay[field]}
                                  onChange={(event) => changeOverlayNumber(overlay.id, field, event.target.value)}
                                  className="mt-1 min-h-12 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-base text-white"
                                />
                              </label>
                            ))}
                          </div>
                          <label className="block text-xs text-slate-400">
                            Opacity · {Math.round(overlay.opacity * 100)}%
                            <input
                              type="range"
                              min="0"
                              max="1"
                              step="0.05"
                              value={overlay.opacity}
                              onChange={(event) => updateOverlay(overlay.id, { opacity: Number(event.target.value) })}
                              className="min-h-12 w-full accent-fuchsia-400"
                            />
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                </div>
              </details>
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
            </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
