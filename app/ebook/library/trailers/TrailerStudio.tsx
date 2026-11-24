"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import TrailerVideoPreview from "./TrailerVideoPreview";
import {
  TrailerCatalogSchema,
  TrailerProjectSchema,
  PublishedTrailerSchema,
  TrailerTransitionSchema,
  TrailerSuggestionResponseSchema,
  type TrailerMoment,
  type TrailerMusicTrack,
  type TrailerProject,
} from "@/lib/schemas/trailer";
import {
  SHORT_MEDIA_SUGGESTION_MAX_CAPTIONS,
  SHORT_MEDIA_SUGGESTION_MAX_TRANSCRIPT_CHARACTERS,
  ShortMusicSuggestionsResponseSchema,
  type ShortMusicSuggestion,
} from "@/lib/schemas/short-media";
import {
  LibraryVideoCatalogSchema,
  LibraryVideoRecordSchema,
  LibraryVideoSegmentSchema,
} from "@/lib/schemas/library-video";
import { MAX_VIDEO_SOURCE_FILE_BYTES, ShortAspectRatioSchema } from "@/lib/schemas/video-short";
import { deleteShortSource, getShortSource, saveShortSource } from "@/lib/short-video-store";
import { exportTrailerVideo } from "@/lib/trailer-video-export";
import { transcribeVideoSource } from "@/lib/video-transcription";
import {
  createTrailerFrameSlots,
  getTrailerFrameAtTime,
  getTrailerFrameSlots,
  prepareTrailerMusicSearchCaptions,
  resizeTrailerFrameSlots,
  setTrailerFrameKeyframe,
  splitTrailerFrameSlot as splitTrailerFrameSlots,
  type TrailerFramePosition,
} from "@/lib/trailer-utils";

const ErrorSchema = z.object({ error: z.string() });
const TranscriptResponseSchema = z.object({
  videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  transcript: z.string(),
  segments: z.array(LibraryVideoSegmentSchema).min(1).max(20000),
}).strict();
const SavedProjectResponseSchema = z.object({ project: TrailerProjectSchema }).strict();
const TrailerUploadResponseSchema = z.object({
  presignedUrl: z.string().url(),
  videoUrl: z.string().url(),
  contentType: z.enum(["video/mp4", "video/webm"]),
}).strict();
const PublishedTrailerResponseSchema = z.object({ trailer: PublishedTrailerSchema }).strict();
const MAX_SOURCE_DURATION_SECONDS = 3600;
const MAX_TRAILER_SECONDS = 300;
const SCREEN_PRESETS = [
  { id: "vertical-social", label: "Shorts / Reels / TikTok", aspectRatio: "9:16" },
  { id: "portrait-feed", label: "Portrait feed", aspectRatio: "4:5" },
  { id: "square-feed", label: "Square feed", aspectRatio: "1:1" },
  { id: "widescreen", label: "YouTube / widescreen", aspectRatio: "16:9" },
] as const;
const TRANSITION_OPTIONS = [
  { id: "cut", label: "Cut" },
  { id: "fade", label: "Fade through black" },
  { id: "slide-left", label: "Slide from left" },
  { id: "slide-right", label: "Slide from right" },
  { id: "slide-up", label: "Slide from top" },
  { id: "slide-down", label: "Slide from bottom" },
  { id: "zoom-in", label: "Zoom in" },
  { id: "zoom-out", label: "Zoom out" },
] as const;

type Catalog = z.infer<typeof TrailerCatalogSchema>;
type PlayRequest = { index: number; nonce: number };
type SeekRequest = { index: number; timeSeconds: number; nonce: number };

function projectRenderSignature(project: TrailerProject): string {
  const { updatedAt: _updatedAt, ...renderableProject } = project;
  return JSON.stringify(renderableProject);
}

function fitSoundtracksToDuration(
  tracks: TrailerMusicTrack[],
  previousDuration: number,
  nextDuration: number,
): TrailerMusicTrack[] {
  return tracks.flatMap((track) => {
    if (track.startSeconds >= nextDuration) return [];
    const coversWholeTrailer = track.startSeconds <= 0.001
      && track.endSeconds >= previousDuration - 0.05;
    const endSeconds = coversWholeTrailer
      ? nextDuration
      : Math.min(track.endSeconds, nextDuration);
    if (endSeconds - track.startSeconds < 0.1) return [];
    const maxFadeSeconds = (endSeconds - track.startSeconds) / 2;
    return [{
      ...track,
      endSeconds,
      fadeInSeconds: Math.min(track.fadeInSeconds, maxFadeSeconds),
      fadeOutSeconds: Math.min(track.fadeOutSeconds, maxFadeSeconds),
    }];
  });
}

async function requestJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  const body: unknown = await response.json();
  if (!response.ok) {
    const parsed = ErrorSchema.safeParse(body);
    throw new Error(parsed.success ? parsed.data.error : `Request failed (HTTP ${response.status}).`);
  }
  return body;
}

function createSlug(): string {
  return `trailer-${crypto.randomUUID()}`;
}

function initialMoment(
  segments: z.infer<typeof LibraryVideoSegmentSchema>[],
  durationSeconds: number,
  aspectRatio: z.infer<typeof ShortAspectRatioSchema>,
): TrailerMoment {
  const first = segments[0];
  const startSeconds = first?.startSeconds ?? 0;
  const endSeconds = Math.min(durationSeconds, Math.max(startSeconds + 6, first?.endSeconds ?? 0));
  const momentEndSeconds = Math.max(startSeconds + 0.1, endSeconds);
  return {
    id: crypto.randomUUID(),
    startSeconds,
    endSeconds: momentEndSeconds,
    title: "Opening hook",
    hook: first?.text.slice(0, 240) ?? "",
    reason: "Edit this moment or generate an AI-curated sequence.",
    transitionIn: "cut",
    transitionOut: "cut",
    transitionDurationSeconds: 0.5,
    frameSlots: createTrailerFrameSlots(startSeconds, momentEndSeconds, aspectRatio, {
      timeSeconds: startSeconds,
      x: 50,
      y: 50,
      zoom: 1,
      fit: "cover",
    }),
  };
}

function createProject(input: {
  slug?: string;
  title: string;
  videoId?: string;
  youtubeUrl?: string;
  uploadedFileName?: string;
  durationSeconds: number;
  segments: z.infer<typeof LibraryVideoSegmentSchema>[];
}): TrailerProject {
  const project = TrailerProjectSchema.parse({
    slug: input.slug ?? createSlug(),
    title: input.title.trim() || "Untitled trailer",
    source: {
      ...(input.videoId ? { videoId: input.videoId } : {}),
      ...(input.youtubeUrl ? { youtubeUrl: input.youtubeUrl } : {}),
      videoTitle: input.title.trim(),
      ...(input.uploadedFileName ? { uploadedFileName: input.uploadedFileName } : {}),
    },
    sourceDurationSeconds: input.durationSeconds,
    transcript: input.segments,
    moments: [initialMoment(input.segments, input.durationSeconds, "9:16")],
    aspectRatio: "9:16",
    fit: "cover",
    cropX: 50,
    cropY: 50,
    zoom: 1,
    headline: "",
    brandLine: "",
    callToAction: "",
    updatedAt: new Date().toISOString(),
  });
  return project;
}

function getFileContentType(file: File): "video/mp4" | "video/webm" {
  if (file.type === "video/mp4" || file.type === "video/webm") return file.type;
  const filename = file.name.toLocaleLowerCase();
  if (filename.endsWith(".mp4")) return "video/mp4";
  if (filename.endsWith(".webm")) return "video/webm";
  throw new Error("Choose an MP4 or WebM source video.");
}

function readVideoDuration(file: File): Promise<number> {
  const video = document.createElement("video");
  const objectUrl = URL.createObjectURL(file);
  video.preload = "metadata";
  video.src = objectUrl;
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener("loadedmetadata", onLoaded);
      video.removeEventListener("error", onError);
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(objectUrl);
    };
    const onLoaded = () => {
      const duration = video.duration;
      cleanup();
      if (!Number.isFinite(duration) || duration < 0.1 || duration > 3600) {
        reject(new Error("Source video duration must be between 0 and 60 minutes."));
        return;
      }
      resolve(duration);
    };
    const onError = () => {
      cleanup();
      reject(new Error("The selected source video could not be read by this browser."));
    };
    video.addEventListener("loadedmetadata", onLoaded, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

function formatTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  const remaining = whole % 60;
  return `${minutes}:${String(remaining).padStart(2, "0")}`;
}

export default function TrailerStudio() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [project, setProject] = useState<TrailerProject | null>(null);
  const [libraryVideos, setLibraryVideos] = useState<z.infer<typeof LibraryVideoCatalogSchema>["videos"]>([]);
  const [selectedLibraryVideoId, setSelectedLibraryVideoId] = useState("");
  const [libraryVideosLoading, setLibraryVideosLoading] = useState(true);
  const [libraryVideosError, setLibraryVideosError] = useState("");
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [sourceTitle, setSourceTitle] = useState("");
  const [editorDirection, setEditorDirection] = useState("");
  const [localVideoUrl, setLocalVideoUrl] = useState<string | null>(null);
  const [sourceFileReady, setSourceFileReady] = useState(false);
  const [playRequest, setPlayRequest] = useState<PlayRequest | null>(null);
  const [seekRequest, setSeekRequest] = useState<SeekRequest | null>(null);
  const [activeMoment, setActiveMoment] = useState(0);
  const [previewTime, setPreviewTime] = useState(0);
  const [soundtrackSuggestions, setSoundtrackSuggestions] = useState<ShortMusicSuggestion[]>([]);
  const [soundtrackMood, setSoundtrackMood] = useState("Catchy cinematic promotional instrumental, uplifting build, strong rhythmic hook, no vocals");
  const [musicSearchBusy, setMusicSearchBusy] = useState(false);
  const [manualStart, setManualStart] = useState("0");
  const [manualEnd, setManualEnd] = useState("8");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [exportProgress, setExportProgress] = useState<number | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [downloadName, setDownloadName] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const localFileRef = useRef<File | null>(null);
  const exportedVideoRef = useRef<Blob | null>(null);
  const exportedProjectSignatureRef = useRef<string | null>(null);

  const loadCatalog = useCallback(async () => {
    const body = await requestJson("/api/ebook/trailers", { cache: "no-store" });
    const parsed = TrailerCatalogSchema.safeParse(body);
    if (!parsed.success) throw new Error("The saved trailer catalog has an invalid format.");
    setCatalog(parsed.data);
  }, []);

  useEffect(() => {
    let active = true;
    loadCatalog()
      .catch((loadError: unknown) => {
        if (active) setError(loadError instanceof Error ? loadError.message : "Could not load saved trailers.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [loadCatalog]);

  useEffect(() => {
    let active = true;
    requestJson("/api/library/videos", { cache: "no-store" })
      .then((body) => {
        const parsed = LibraryVideoCatalogSchema.safeParse(body);
        if (!parsed.success) throw new Error("The approved video catalog has an invalid format.");
        if (active) {
          setLibraryVideos(parsed.data.videos);
          setSelectedLibraryVideoId(parsed.data.videos[0]?.videoId ?? "");
        }
      })
      .catch((loadError: unknown) => {
        if (active) {
          setLibraryVideosError(loadError instanceof Error ? loadError.message : "Could not load approved videos.");
        }
      })
      .finally(() => {
        if (active) setLibraryVideosLoading(false);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => () => {
    if (localVideoUrl?.startsWith("blob:")) URL.revokeObjectURL(localVideoUrl);
  }, [localVideoUrl]);

  useEffect(() => () => {
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  }, [downloadUrl]);

  const handlePreviewError = useCallback((message: string) => setError(message), []);
  const handleActiveMomentChange = useCallback((index: number) => setActiveMoment(index), []);
  const handleCurrentTimeChange = useCallback((timeSeconds: number) => setPreviewTime(timeSeconds), []);

  function resetEditor() {
    setProject(null);
    setLocalVideoUrl(null);
    setSourceFileReady(false);
    localFileRef.current = null;
    exportedVideoRef.current = null;
    exportedProjectSignatureRef.current = null;
    setPlayRequest(null);
    setSeekRequest(null);
    setPreviewTime(0);
    setSoundtrackSuggestions([]);
    setDownloadUrl(null);
    setSourceTitle("");
    setYoutubeUrl("");
    setError("");
    setNotice("");
  }

  function playFromMoment(index: number) {
    setPlayRequest((current) => ({ index, nonce: (current?.nonce ?? 0) + 1 }));
    setActiveMoment(index);
    setPreviewTime(project?.moments[index]?.startSeconds ?? 0);
    setError("");
  }

  function seekPreview(timeSeconds: number) {
    const moment = project?.moments[activeMoment];
    if (!moment) return;
    const nextTime = Math.max(moment.startSeconds, Math.min(moment.endSeconds, timeSeconds));
    requestPreviewSeek(activeMoment, nextTime);
  }

  function requestPreviewSeek(index: number, timeSeconds: number) {
    setPreviewTime(timeSeconds);
    setSeekRequest((current) => ({
      index,
      timeSeconds,
      nonce: (current?.nonce ?? 0) + 1,
    }));
  }

  async function createFromApprovedVideo() {
    if (!selectedLibraryVideoId) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const body = await requestJson(`/api/library/videos/${encodeURIComponent(selectedLibraryVideoId)}`, {
        cache: "no-store",
      });
      const parsed = LibraryVideoRecordSchema.safeParse(body);
      if (!parsed.success) throw new Error("The approved video transcript has an invalid format.");

      const record = parsed.data;
      const fullDuration = Math.max(...record.segments.map((segment) => segment.endSeconds));
      const durationSeconds = Math.min(fullDuration, MAX_SOURCE_DURATION_SECONDS);
      const segments = record.segments.flatMap((segment) => {
        if (segment.startSeconds >= durationSeconds) return [];
        const endSeconds = Math.min(segment.endSeconds, durationSeconds);
        return endSeconds > segment.startSeconds ? [{ ...segment, endSeconds }] : [];
      });
      if (durationSeconds <= 0 || segments.length === 0) {
        throw new Error("This approved transcript has no usable timestamps for Trailer Studio.");
      }

      const next = createProject({
        title: record.title,
        videoId: record.videoId,
        youtubeUrl: record.youtubeUrl,
        durationSeconds,
        segments,
      });
      setProject(next);
      setSourceTitle(record.title);
      setManualStart(String(next.moments[0].startSeconds));
      setManualEnd(String(next.moments[0].endSeconds));
      setActiveMoment(0);
      requestPreviewSeek(0, next.moments[0].startSeconds);
      setLocalVideoUrl(null);
      setSourceFileReady(false);
      localFileRef.current = null;
      setNotice(fullDuration > MAX_SOURCE_DURATION_SECONDS
        ? "Approved transcript loaded. Trailer editing is limited to the first 60 minutes of this video."
        : "Approved video and transcript loaded. Ask AI to curate moments, or edit the opening moment and add your own.");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load the approved video transcript.");
    } finally {
      setBusy(false);
    }
  }

  async function createFromYouTube() {
    if (!youtubeUrl.trim()) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const body = await requestJson("/api/fetch-youtube-transcript", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: youtubeUrl.trim() }),
      });
      const parsed = TranscriptResponseSchema.safeParse(body);
      if (!parsed.success) throw new Error("YouTube transcript service returned an invalid transcript.");
      const durationSeconds = Math.max(...parsed.data.segments.map((segment) => segment.endSeconds));
      const title = sourceTitle.trim() || `YouTube trailer ${parsed.data.videoId}`;
      const next = createProject({
        title,
        videoId: parsed.data.videoId,
        youtubeUrl: youtubeUrl.trim(),
        durationSeconds,
        segments: parsed.data.segments,
      });
      setProject(next);
      setSourceTitle(title);
      setManualStart(String(next.moments[0].startSeconds));
      setManualEnd(String(next.moments[0].endSeconds));
      setActiveMoment(0);
      requestPreviewSeek(0, next.moments[0].startSeconds);
      setLocalVideoUrl(null);
      setSourceFileReady(false);
      localFileRef.current = null;
      setNotice("Transcript loaded. Ask AI to curate moments, or edit the opening moment and add your own.");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load this YouTube source.");
    } finally {
      setBusy(false);
    }
  }

  async function uploadSource(file: File, currentProject?: TrailerProject) {
    if (file.size === 0 || file.size > MAX_VIDEO_SOURCE_FILE_BYTES) {
      throw new Error("Source videos must be non-empty and 500 MB or smaller.");
    }
    getFileContentType(file);
    const durationSeconds = await readVideoDuration(file);
    if (currentProject && currentProject.moments.some((moment) => moment.endSeconds > durationSeconds)) {
      throw new Error("This source is shorter than one or more trailer moments. Upload the matching source or adjust the moments first.");
    }
    const slug = currentProject?.slug ?? createSlug();
    localFileRef.current = file;
    setLocalVideoUrl(URL.createObjectURL(file));
    setSourceFileReady(true);

    let sourceStorageWarning = "";
    try {
      await saveShortSource(slug, file);
    } catch (storageError) {
      sourceStorageWarning = storageError instanceof Error
        ? `The browser could not store a source copy (${storageError.message}); the file remains available for this session.`
        : "The browser could not store a source copy; the file remains available for this session.";
    }

    let transcript = currentProject?.transcript ?? [];
    let transcriptionWarning = "";
    try {
      const transcribedSegments = await transcribeVideoSource(file);
      transcript = transcribedSegments.flatMap((segment) => {
        if (segment.startSeconds >= durationSeconds) return [];
        const endSeconds = Math.min(segment.endSeconds, durationSeconds);
        return endSeconds > segment.startSeconds ? [{ ...segment, endSeconds }] : [];
      });
      if (transcript.length === 0) throw new Error("No usable speech timestamps were found in this source.");
    } catch (transcriptionError) {
      transcriptionWarning = transcriptionError instanceof Error
        ? transcriptionError.message
        : "Automatic transcription failed.";
    }
    if (currentProject) {
      setProject({
        ...currentProject,
        source: {
          ...currentProject.source,
          uploadedFileName: file.name,
        },
        sourceDurationSeconds: Math.max(currentProject.sourceDurationSeconds, durationSeconds),
        ...(transcriptionWarning ? {} : { transcript }),
      });
      setNotice(transcriptionWarning
        ? "Source is available in this session. Existing transcript was kept; retry transcription or curate from the saved transcript."
        : "Source transcribed. You can now curate trailer moments from the uploaded video.");
      const warnings = [sourceStorageWarning, transcriptionWarning && `Transcription failed: ${transcriptionWarning}`]
        .filter(Boolean);
      if (warnings.length > 0) setError(warnings.join(" "));
      return;
    }

    const title = sourceTitle.trim() || file.name.replace(/\.[^.]+$/, "");
    const next = createProject({
      slug,
      title,
      uploadedFileName: file.name,
      durationSeconds,
      segments: transcript,
    });
    setProject(next);
    setSourceTitle(title);
    setManualStart(String(next.moments[0].startSeconds));
    setManualEnd(String(next.moments[0].endSeconds));
    setActiveMoment(0);
    requestPreviewSeek(0, next.moments[0].startSeconds);
    setNotice(transcriptionWarning
      ? "Source is available in this session. Add moments manually; AI curation needs a transcript."
      : "Source transcribed. Ask AI to curate a trailer sequence.");
    const warnings = [sourceStorageWarning, transcriptionWarning && `Transcription failed: ${transcriptionWarning}`]
      .filter(Boolean);
    if (warnings.length > 0) setError(warnings.join(" "));
  }

  async function retranscribeSource() {
    if (!project || !localFileRef.current) {
      setError("Re-select the source video before retrying transcription.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const segments = await transcribeVideoSource(localFileRef.current);
      if (segments.length === 0) throw new Error("No usable speech timestamps were found in this source.");
      setProject((current) => current ? { ...current, transcript: segments } : current);
      setNotice("Source transcribed. AI moment curation is ready.");
    } catch (transcriptionError) {
      setError(transcriptionError instanceof Error
        ? `Transcription failed: ${transcriptionError.message}`
        : "Could not transcribe this source.");
    } finally {
      setBusy(false);
    }
  }

  async function handleSourceFile(file: File | undefined, input: HTMLInputElement) {
    if (!file) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await uploadSource(file, project ?? undefined);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Could not upload this source video.");
    } finally {
      setBusy(false);
      input.value = "";
    }
  }

  async function curateMoments() {
    if (!project || project.transcript.length === 0) {
      setError("Load a timestamped transcript before asking AI to curate moments.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const body = await requestJson("/api/ebook/trailers/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: project.title,
          durationSeconds: project.sourceDurationSeconds,
          segments: project.transcript,
          instructions: editorDirection,
        }),
      });
      const parsed = TrailerSuggestionResponseSchema.safeParse(body);
      if (!parsed.success) throw new Error("AI returned an invalid trailer curation.");
      const orderedSuggestions = parsed.data.suggestions.slice(0, 24);
      const totalDuration = orderedSuggestions.reduce(
        (total, moment) => total + moment.endSeconds - moment.startSeconds,
        0,
      );
      if (totalDuration > MAX_TRAILER_SECONDS) {
        throw new Error("AI selected too much footage. Add a shorter direction and try again.");
      }
      setProject((current) => current ? {
        ...current,
        musicTracks: fitSoundtracksToDuration(
          current.musicTracks,
          current.moments.reduce((duration, moment) => duration + moment.endSeconds - moment.startSeconds, 0),
          totalDuration,
        ),
        moments: (() => {
          const currentFrame = getTrailerFrameAtTime(current, activeMoment, previewTime);
          const position = currentFrame?.position ?? {
            timeSeconds: previewTime,
            x: 50,
            y: 50,
            zoom: 1,
            fit: current.fit,
          };
          const aspectRatio = currentFrame?.slot.aspectRatio ?? current.aspectRatio;
          return orderedSuggestions.map((moment) => ({
            id: crypto.randomUUID(),
            ...moment,
            transitionIn: "cut" as const,
            transitionOut: "cut" as const,
            transitionDurationSeconds: 0.5,
            frameSlots: createTrailerFrameSlots(
              moment.startSeconds,
              moment.endSeconds,
              aspectRatio,
              position,
            ),
          }));
        })(),
      } : current);
      setActiveMoment(0);
      requestPreviewSeek(0, orderedSuggestions[0]?.startSeconds ?? 0);
      setNotice("AI sequence created. Review and edit every selected moment before saving or exporting.");
    } catch (curationError) {
      setError(curationError instanceof Error ? curationError.message : "Could not curate trailer moments.");
    } finally {
      setBusy(false);
    }
  }

  async function findSoundtrackSuggestions() {
    if (!project) return;
    setMusicSearchBusy(true);
    setError("");
    setNotice("");
    try {
      const sourceCaptions = project.transcript.length > 0
        ? project.transcript
        : project.moments.map((moment) => ({
          startSeconds: moment.startSeconds,
          endSeconds: moment.endSeconds,
          text: [moment.title, moment.hook].filter(Boolean).join(": ").slice(0, 2000),
        })).filter((segment) => segment.text);
      const captions = prepareTrailerMusicSearchCaptions(sourceCaptions);
      if (captions.length === 0) throw new Error("Add a transcript or a moment hook before requesting soundtrack ideas.");
      if (
        captions.length > SHORT_MEDIA_SUGGESTION_MAX_CAPTIONS
        || captions.reduce((total, caption) => total + caption.text.length, 0) > SHORT_MEDIA_SUGGESTION_MAX_TRANSCRIPT_CHARACTERS
      ) {
        throw new Error("The transcript could not be reduced to the soundtrack search limit. Try again or use fewer transcript segments.");
      }
      const body = await requestJson("/api/ebook/shorts/media-suggestions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "music",
          title: project.title,
          startSeconds: 0,
          endSeconds: project.sourceDurationSeconds,
          frameSlots: [{
            startSeconds: 0,
            endSeconds: project.sourceDurationSeconds,
            aspectRatio: project.aspectRatio,
          }],
          captions,
          instructions: soundtrackMood,
        }),
      });
      const parsed = ShortMusicSuggestionsResponseSchema.safeParse(body);
      if (!parsed.success || parsed.data.suggestions.length === 0) {
        throw new Error("AI returned invalid soundtrack suggestions.");
      }
      setSoundtrackSuggestions(parsed.data.suggestions);
      setNotice("AI found instrumental options. Preview a track, add it to the trailer, then verify its license before publishing.");
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : "Could not suggest trailer soundtracks.");
    } finally {
      setMusicSearchBusy(false);
    }
  }

  function addSoundtrack(suggestion: ShortMusicSuggestion) {
    if (!project) return;
    if (project.musicTracks.length >= 5) {
      setError("A trailer can have up to five soundtrack layers.");
      return;
    }
    const durationSeconds = project.moments.reduce(
      (total, moment) => total + moment.endSeconds - moment.startSeconds,
      0,
    );
    if (durationSeconds <= 0) {
      setError("Add a trailer moment before adding a soundtrack.");
      return;
    }
    const track: TrailerMusicTrack = {
      id: crypto.randomUUID(),
      fileName: suggestion.title,
      audioUrl: suggestion.audioUrl,
      sourceDurationSeconds: suggestion.durationSeconds,
      startSeconds: 0,
      endSeconds: durationSeconds,
      volume: 0.22,
      fadeInSeconds: Math.min(1.5, durationSeconds / 2),
      fadeOutSeconds: Math.min(2, durationSeconds / 2),
      duckUnderSpeech: true,
      duckVolume: 0.14,
      loop: true,
      provider: "jamendo",
      providerPageUrl: suggestion.providerPageUrl,
      creatorName: suggestion.artistName,
      creatorUrl: suggestion.creatorUrl,
      licenseName: suggestion.licenseName,
      licenseUrl: suggestion.licenseUrl,
      commercialLicenseConfirmed: false,
    };
    setProject({ ...project, musicTracks: [...project.musicTracks, track] });
    setError("");
    setNotice("Soundtrack added to the full trailer, looped to fit, and ducked under transcript dialogue. Confirm the license before publishing.");
  }

  function updateSoundtrack(id: string, patch: Partial<TrailerMusicTrack>) {
    setProject((current) => current ? {
      ...current,
      musicTracks: current.musicTracks.map((track) =>
        track.id === id ? { ...track, ...patch } : track,
      ),
    } : current);
  }

  async function saveProject() {
    if (!project) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const validated = TrailerProjectSchema.parse(project);
      const body = await requestJson("/api/ebook/trailers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", project: validated }),
      });
      const parsed = SavedProjectResponseSchema.safeParse(body);
      if (!parsed.success) throw new Error("Trailer save returned an invalid project.");
      setProject(parsed.data.project);
      setCatalog((current) => ({
        updatedAt: parsed.data.project.updatedAt,
        trailers: [
          {
            slug: parsed.data.project.slug,
            title: parsed.data.project.title,
            updatedAt: parsed.data.project.updatedAt,
            status: current?.trailers.find((trailer) => trailer.slug === parsed.data.project.slug)?.status ?? "draft",
          },
          ...(current?.trailers ?? []).filter((trailer) => trailer.slug !== parsed.data.project.slug),
        ],
      }));
      setNotice("Trailer project saved privately. You can reopen and edit it from Saved trailers.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save this trailer.");
    } finally {
      setBusy(false);
    }
  }

  async function openProject(slug: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const body = await requestJson(`/api/ebook/trailers/${encodeURIComponent(slug)}`, { cache: "no-store" });
      const parsed = TrailerProjectSchema.safeParse(body);
      if (!parsed.success) throw new Error("The saved trailer has an invalid format.");
      setProject(parsed.data);
      setSourceTitle(parsed.data.title);
      setManualStart(String(parsed.data.moments[0].startSeconds));
      setManualEnd(String(parsed.data.moments[0].endSeconds));
      setActiveMoment(0);
      setPlayRequest(null);
      requestPreviewSeek(0, parsed.data.moments[0].startSeconds);
      setDownloadUrl(null);
      exportedVideoRef.current = null;
      exportedProjectSignatureRef.current = null;
      let blob: Blob | null = null;
      try {
        blob = await getShortSource(slug);
      } catch (storageError) {
        throw new Error(storageError instanceof Error ? storageError.message : "Could not restore the local source video.");
      }
      if (blob) {
        const file = new File([blob], parsed.data.source.uploadedFileName ?? "trailer-source.mp4", {
          type: blob.type || "video/mp4",
        });
        localFileRef.current = file;
        setLocalVideoUrl(URL.createObjectURL(file));
        setSourceFileReady(true);
      } else {
        localFileRef.current = null;
        setSourceFileReady(false);
        setLocalVideoUrl(null);
      }
      setNotice(blob || !parsed.data.source.uploadedFileName
        ? "Trailer project opened."
        : parsed.data.source.videoId
          ? "Project opened. YouTube preview is ready; re-select the source file on this device to export."
          : "Project opened. Re-select the source file on this device to preview or export it.");
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : "Could not open this trailer.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteProject() {
    if (!project) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const body = await requestJson("/api/ebook/trailers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", slug: project.slug }),
      });
      const parsed = TrailerCatalogSchema.safeParse(body);
      if (!parsed.success) throw new Error("Trailer deletion returned an invalid catalog.");
      setCatalog(parsed.data);
      resetEditor();
      try {
        await deleteShortSource(project.slug);
        setNotice("Trailer project deleted.");
      } catch (sourceError) {
        setNotice(`Trailer project deleted, but its local source could not be removed: ${sourceError instanceof Error ? sourceError.message : "browser storage failed."}`);
      }
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Could not delete this trailer.");
    } finally {
      setBusy(false);
    }
  }

  async function exportProject() {
    if (!project?.source.uploadedFileName) {
      setError("Upload an authorized source video before exporting. YouTube embed projects remain preview-only.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    setExportProgress(0);
    setDownloadUrl(null);
    exportedVideoRef.current = null;
    exportedProjectSignatureRef.current = null;
    exportedVideoRef.current = null;
    exportedProjectSignatureRef.current = null;
    try {
      let file = localFileRef.current;
      if (!file) {
        const blob = await getShortSource(project.slug);
        if (blob) file = new File([blob], project.source.uploadedFileName ?? "trailer-source.mp4", { type: blob.type || "video/mp4" });
      }
      if (!file) throw new Error("Re-select the uploaded source video on this device before exporting.");
      const result = await exportTrailerVideo(project, file, setExportProgress);
      exportedVideoRef.current = result.blob;
      exportedProjectSignatureRef.current = projectRenderSignature(project);
      setDownloadUrl(URL.createObjectURL(result.blob));
      setDownloadName(`${project.slug}.${result.extension}`);
      setNotice("Trailer export is ready to download.");
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "Could not export this trailer.");
    } finally {
      setBusy(false);
      setExportProgress(null);
    }
  }

  async function publishProject(sourceType: "youtube" | "upload") {
    if (!project) return;
    const unlicensedTrack = project?.musicTracks.find((track) => !track.commercialLicenseConfirmed);
    if (unlicensedTrack) {
      setError(`Confirm the commercial license for “${unlicensedTrack.fileName}” before publishing.`);
      return;
    }
    if (sourceType === "youtube" && !project.source.videoId) {
      setError("This trailer has no YouTube source to publish as an embedded video.");
      return;
    }
    if (sourceType === "upload" && (!exportedVideoRef.current || !downloadUrl
      || exportedProjectSignatureRef.current !== projectRenderSignature(project))) {
      setError("Render the trailer again after your latest edits before publishing.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const validatedProject = TrailerProjectSchema.parse(project);
      const saveBody = await requestJson("/api/ebook/trailers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", project: validatedProject }),
      });
      const saved = SavedProjectResponseSchema.safeParse(saveBody);
      if (!saved.success) throw new Error("Trailer save returned an invalid project.");
      setProject(saved.data.project);

      let videoUrl: string | undefined;
      if (sourceType === "upload") {
        const blob = exportedVideoRef.current;
        if (!blob) throw new Error("Render the latest trailer before publishing the rendered video.");
        const contentType = blob.type.includes("mp4") ? "video/mp4" : "video/webm";
        const uploadBody = await requestJson("/api/ebook/trailers/source", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filename: `${validatedProject.slug}.${contentType === "video/mp4" ? "mp4" : "webm"}`,
            contentType,
            size: blob.size,
          }),
        });
        const upload = TrailerUploadResponseSchema.safeParse(uploadBody);
        if (!upload.success) throw new Error("Trailer upload returned an invalid response.");
        const uploadResponse = await fetch(upload.data.presignedUrl, {
          method: "PUT",
          headers: { "Content-Type": upload.data.contentType },
          body: blob,
        });
        if (!uploadResponse.ok) throw new Error(`Could not upload rendered trailer (HTTP ${uploadResponse.status}).`);
        videoUrl = upload.data.videoUrl;
      }

      const publishBody = await requestJson("/api/ebook/trailers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "publish",
          slug: validatedProject.slug,
          title: validatedProject.title,
          sourceType,
          ...(sourceType === "youtube" ? {
            videoId: validatedProject.source.videoId,
            videoTitle: validatedProject.source.videoTitle,
            moments: validatedProject.moments,
            musicTracks: validatedProject.musicTracks,
            headline: validatedProject.headline,
            brandLine: validatedProject.brandLine,
            callToAction: validatedProject.callToAction,
          } : { videoUrl }),
          aspectRatio: getTrailerFrameSlots(validatedProject, 0)[0]?.aspectRatio ?? validatedProject.aspectRatio,
        }),
      });
      const published = PublishedTrailerResponseSchema.safeParse(publishBody);
      if (!published.success) throw new Error("Trailer publishing returned an invalid response.");
      setCatalog((current) => ({
        updatedAt: published.data.trailer.updatedAt,
        trailers: [
          {
            slug: published.data.trailer.slug,
            title: published.data.trailer.title,
            updatedAt: published.data.trailer.updatedAt,
            status: "published",
          },
          ...(current?.trailers ?? []).filter((trailer) => trailer.slug !== published.data.trailer.slug),
        ],
      }));
      setNotice(sourceType === "youtube"
        ? `YouTube trailer published. Share /library/trailers/${published.data.trailer.slug} with your audience.`
        : `Rendered trailer published. Share /library/trailers/${published.data.trailer.slug} with your audience.`);
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : "Could not publish this trailer.");
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
      const body = await requestJson("/api/ebook/trailers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "unpublish", slug: project.slug }),
      });
      const parsed = TrailerCatalogSchema.safeParse(body);
      if (!parsed.success) throw new Error("Trailer unpublish returned an invalid catalog.");
      setCatalog(parsed.data);
      setNotice("Trailer unpublished from the Library. The private draft is still available.");
    } catch (unpublishError) {
      setError(unpublishError instanceof Error ? unpublishError.message : "Could not unpublish this trailer.");
    } finally {
      setBusy(false);
    }
  }

  function updateMoment(index: number, patch: Partial<TrailerMoment>) {
    const currentMoment = project?.moments[index];
    if (!project || !currentMoment) return;
    const nextStart = patch.startSeconds ?? currentMoment.startSeconds;
    const nextEnd = patch.endSeconds ?? currentMoment.endSeconds;
    if (
      (patch.startSeconds !== undefined || patch.endSeconds !== undefined)
      && (nextStart < 0 || nextEnd <= nextStart || nextEnd > project.sourceDurationSeconds)
    ) {
      setError("Enter a valid moment range inside the source video.");
      return;
    }
    let resizedFrameSlots: ReturnType<typeof getTrailerFrameSlots> | undefined;
    let nextTrailerDuration: number | undefined;
    if (patch.startSeconds !== undefined || patch.endSeconds !== undefined) {
      try {
        resizedFrameSlots = resizeTrailerFrameSlots(
          getTrailerFrameSlots(project, index),
          nextStart,
          nextEnd,
        );
        nextTrailerDuration = project.moments.reduce(
          (duration, moment, momentIndex) => duration
            + (momentIndex === index
              ? nextEnd - nextStart
              : moment.endSeconds - moment.startSeconds),
          0,
        );
      } catch (resizeError) {
        setError(resizeError instanceof Error ? resizeError.message : "Could not resize this moment's framing slots.");
        return;
      }
    }
    setProject((current) => current ? {
      ...current,
      ...(nextTrailerDuration === undefined ? {} : {
        musicTracks: fitSoundtracksToDuration(
          current.musicTracks,
          current.moments.reduce((duration, moment) => duration + moment.endSeconds - moment.startSeconds, 0),
          nextTrailerDuration,
        ),
      }),
      moments: current.moments.map((moment, momentIndex) => {
        if (momentIndex !== index) return moment;
        return {
          ...moment,
          ...patch,
          ...(resizedFrameSlots ? { frameSlots: resizedFrameSlots } : {}),
        };
      }),
    } : current);
    if (index === activeMoment && (patch.startSeconds !== undefined || patch.endSeconds !== undefined)) {
      const timeSeconds = Math.max(nextStart, Math.min(nextEnd, previewTime));
      requestPreviewSeek(index, timeSeconds);
    }
  }

  function moveMoment(index: number, direction: -1 | 1) {
    if (!project) return;
    const target = index + direction;
    if (target < 0 || target >= project.moments.length) return;
    const moments = [...project.moments];
    [moments[index], moments[target]] = [moments[target], moments[index]];
    setProject({ ...project, moments });
    setActiveMoment(target);
    requestPreviewSeek(target, moments[target].startSeconds);
  }

  function addManualMoment() {
    if (!project || project.moments.length >= 24) return;
    const startSeconds = Number(manualStart);
    const endSeconds = Number(manualEnd);
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)
      || startSeconds < 0 || endSeconds <= startSeconds
      || endSeconds > project.sourceDurationSeconds) {
      setError("Enter a valid moment range inside the source video.");
      return;
    }
    const total = project.moments.reduce(
      (duration, moment) => duration + moment.endSeconds - moment.startSeconds,
      0,
    ) + endSeconds - startSeconds;
    if (total > MAX_TRAILER_SECONDS) {
      setError("Keep the assembled trailer at five minutes or less.");
      return;
    }
    const transcriptText = project.transcript
      .filter((segment) => segment.endSeconds > startSeconds && segment.startSeconds < endSeconds)
      .map((segment) => segment.text)
      .join(" ");
    const currentFrame = getTrailerFrameAtTime(project, activeMoment, previewTime);
    const framePosition = currentFrame?.position ?? {
      timeSeconds: previewTime,
      x: 50,
      y: 50,
      zoom: 1,
      fit: project.fit,
    };
    const nextMoment: TrailerMoment = {
      id: crypto.randomUUID(),
      startSeconds,
      endSeconds,
      title: `Moment ${project.moments.length + 1}`,
      hook: transcriptText.slice(0, 240),
      reason: "Added manually.",
      transitionIn: "cut",
      transitionOut: "cut",
      transitionDurationSeconds: 0.5,
      frameSlots: createTrailerFrameSlots(
        startSeconds,
        endSeconds,
        currentFrame?.slot.aspectRatio ?? project.aspectRatio,
        framePosition,
      ),
    };
    const previousDuration = project.moments.reduce(
      (duration, moment) => duration + moment.endSeconds - moment.startSeconds,
      0,
    );
    setProject({
      ...project,
      moments: [...project.moments, nextMoment],
      musicTracks: fitSoundtracksToDuration(project.musicTracks, previousDuration, total),
    });
    setActiveMoment(project.moments.length);
    requestPreviewSeek(project.moments.length, startSeconds);
    setError("");
  }

  function removeMoment(index: number) {
    if (!project || project.moments.length <= 1) {
      setError("Keep at least one moment in the trailer.");
      return;
    }
    const moments = project.moments.filter((_, momentIndex) => momentIndex !== index);
    const previousDuration = project.moments.reduce(
      (duration, moment) => duration + moment.endSeconds - moment.startSeconds,
      0,
    );
    const nextDuration = moments.reduce(
      (duration, moment) => duration + moment.endSeconds - moment.startSeconds,
      0,
    );
    setProject({
      ...project,
      moments,
      musicTracks: fitSoundtracksToDuration(project.musicTracks, previousDuration, nextDuration),
    });
    const nextActiveMoment = activeMoment > index ? activeMoment - 1 : Math.min(activeMoment, moments.length - 1);
    setActiveMoment(nextActiveMoment);
    requestPreviewSeek(nextActiveMoment, moments[nextActiveMoment].startSeconds);
  }

  const selectedMoment = project?.moments[activeMoment];
  const canExport = Boolean(project?.source.uploadedFileName && sourceFileReady);
  const isPublished = Boolean(catalog?.trailers.find((trailer) => trailer.slug === project?.slug)?.status === "published");
  const hasCurrentExport = Boolean(
    canExport
    && downloadUrl
    && exportedVideoRef.current
    && project
    && exportedProjectSignatureRef.current === projectRenderSignature(project),
  );
  const canPublishMusic = Boolean(
    project?.musicTracks.every((track) => track.commercialLicenseConfirmed),
  );
  const canPublishEmbedded = Boolean(project?.source.videoId && canPublishMusic);
  const canPublishRendered = Boolean(hasCurrentExport && canPublishMusic);
  const frameAtPlayhead = project
    ? getTrailerFrameAtTime(project, activeMoment, previewTime)
    : null;
  const selectedSlot = frameAtPlayhead?.slot ?? null;
  const selectedFrame = frameAtPlayhead?.position ?? null;
  const activeFrameSlots = project ? getTrailerFrameSlots(project, activeMoment) : [];
  const selectedSlotIndex = activeFrameSlots.findIndex((slot) =>
    previewTime >= slot.startSeconds && previewTime <= slot.endSeconds,
  );
  const projectScreenRatios = project
    ? new Set(project.moments.flatMap((_, index) =>
      getTrailerFrameSlots(project, index).map((slot) => slot.aspectRatio),
    ))
    : new Set<string>();
  const selectedScreenPreset = projectScreenRatios.size === 1
    ? SCREEN_PRESETS.find((preset) => projectScreenRatios.has(preset.aspectRatio))?.id ?? "custom"
    : "custom";

  const setKeyframeAtTime = useCallback((
    timeSeconds: number,
    patch: Partial<TrailerFramePosition>,
    persistFit = false,
  ) => {
    const selectedProjectMoment = project?.moments[activeMoment];
    if (!project || !selectedProjectMoment) return;
    const boundedTime = Math.max(
      selectedProjectMoment.startSeconds,
      Math.min(selectedProjectMoment.endSeconds, timeSeconds),
    );
    let frameSlots: ReturnType<typeof getTrailerFrameSlots>;
    try {
      frameSlots = setTrailerFrameKeyframe(
        getTrailerFrameSlots(project, activeMoment),
        boundedTime,
        patch,
        persistFit,
      );
    } catch (editError) {
      setError(editError instanceof Error ? editError.message : "Could not save this crop keyframe.");
      return;
    }
    setProject((current) => current ? {
      ...current,
      moments: current.moments.map((moment, index) =>
        index === activeMoment ? { ...moment, frameSlots } : moment,
      ),
    } : current);
  }, [activeMoment, project]);

  const splitFrameSlot = useCallback(() => {
    if (!project || !selectedMoment) return;
    let frameSlots: ReturnType<typeof getTrailerFrameSlots>;
    try {
      frameSlots = splitTrailerFrameSlots(getTrailerFrameSlots(project, activeMoment), previewTime);
    } catch (splitError) {
      setError(splitError instanceof Error ? splitError.message : "Could not split this framing slot.");
      return;
    }
    setProject((current) => current ? {
      ...current,
      moments: current.moments.map((moment, index) =>
        index === activeMoment ? { ...moment, frameSlots } : moment,
      ),
    } : current);
    setError("");
    setNotice("Framing slot split at the playhead. Both sides retain the current crop and can now be edited independently.");
  }, [activeMoment, previewTime, project, selectedMoment]);

  const handleCropChange = useCallback((
    timeSeconds: number,
    cropX: number,
    cropY: number,
    zoom: number,
    fit: "cover" | "contain",
  ) => {
    setKeyframeAtTime(timeSeconds, { x: cropX, y: cropY, zoom, fit });
  }, [setKeyframeAtTime]);

  function updateActiveFrameAspectRatio(aspectRatio: z.infer<typeof ShortAspectRatioSchema>) {
    if (!project || !selectedSlot) return;
    const slots = getTrailerFrameSlots(project, activeMoment);
    const selectedSlotIndex = slots.findIndex((slot) =>
      previewTime >= slot.startSeconds && previewTime <= slot.endSeconds,
    );
    if (selectedSlotIndex < 0) return;
    setProject({
      ...project,
      ...(activeMoment === 0 && selectedSlotIndex === 0 ? { aspectRatio } : {}),
      moments: project.moments.map((moment, index) =>
        index === activeMoment
          ? {
            ...moment,
            frameSlots: slots.map((slot, slotIndex) =>
              slotIndex === selectedSlotIndex ? { ...slot, aspectRatio } : slot,
            ),
          }
          : moment,
      ),
    });
  }

  function applyScreenPreset(aspectRatio: z.infer<typeof ShortAspectRatioSchema>) {
    setProject((current) => current ? {
      ...current,
      aspectRatio,
      moments: current.moments.map((moment, index) => ({
        ...moment,
        frameSlots: getTrailerFrameSlots(current, index).map((slot) => ({
          ...slot,
          aspectRatio,
        })),
      })),
    } : current);
  }

  return (
    <div className="space-y-6 pb-20 lg:pb-0">
      {error && <p role="alert" className="rounded-xl border border-rose-900 bg-rose-950/40 p-4 text-sm text-rose-200">{error}</p>}
      {notice && <p role="status" className="rounded-xl border border-cyan-900 bg-cyan-950/30 p-4 text-sm text-cyan-100">{notice}</p>}

      {!project && <section className="space-y-4 rounded-2xl border border-cyan-900/70 bg-cyan-950/20 p-4 lg:p-6">
        <div>
          <h2 className="text-lg font-bold text-white">Use an approved YouTube transcript</h2>
          <p className="mt-1 text-sm leading-relaxed text-slate-300">
            Choose one of your videos already approved in the Video Library. Trailer Studio will use its saved transcript and embedded YouTube video.
          </p>
        </div>
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
          <label className="block">
            <span className="text-sm font-semibold text-slate-200">Approved video</span>
            <select
              value={selectedLibraryVideoId}
              onChange={(event) => setSelectedLibraryVideoId(event.target.value)}
              disabled={libraryVideosLoading || libraryVideos.length === 0}
              className="mt-2 min-h-12 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 text-base text-white disabled:opacity-60"
            >
              <option value="">
                {libraryVideosLoading ? "Loading approved videos…" : "Select an approved video"}
              </option>
              {libraryVideos.map((video) => (
                <option key={video.videoId} value={video.videoId}>{video.title}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => void createFromApprovedVideo()}
            disabled={busy || libraryVideosLoading || !selectedLibraryVideoId}
            className="min-h-12 self-end rounded-xl bg-cyan-300 px-5 text-sm font-bold text-slate-950 disabled:opacity-50"
          >
            {busy ? "Loading video…" : "Load approved video"}
          </button>
        </div>
        {libraryVideosError && (
          <p role="alert" className="text-sm text-rose-200">{libraryVideosError}</p>
        )}
        {!libraryVideosLoading && !libraryVideosError && libraryVideos.length === 0 && (
          <p className="text-sm text-amber-100">
            No approved videos were found. Approve a timestamped transcript in Nexus Director, then refresh this page.
          </p>
        )}
      </section>}

      {!project && <section className="grid gap-4 rounded-2xl border border-slate-800 bg-slate-900/40 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.75fr)] lg:p-6">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void createFromYouTube();
          }}
          className="space-y-3"
        >
          <div>
            <h2 className="text-lg font-bold text-white">Use another YouTube URL</h2>
            <p className="mt-1 text-sm leading-relaxed text-slate-400">
              For a video not yet in the approved library, load its timestamped transcript here. Rendering and publishing require an authorized source file.
            </p>
          </div>
          <label className="block">
            <span className="text-sm font-semibold text-slate-300">YouTube URL</span>
            <input
              type="url"
              value={youtubeUrl}
              onChange={(event) => setYoutubeUrl(event.target.value)}
              placeholder="https://youtube.com/watch?v=…"
              className="mt-2 min-h-12 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 text-base text-white placeholder:text-slate-500"
            />
          </label>
          <label className="block">
            <span className="text-sm font-semibold text-slate-300">Working title (optional)</span>
            <input
              type="text"
              maxLength={120}
              value={sourceTitle}
              onChange={(event) => setSourceTitle(event.target.value)}
              placeholder="Promotion or campaign name"
              className="mt-2 min-h-12 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 text-base text-white placeholder:text-slate-500"
            />
          </label>
          <button
            type="submit"
            disabled={busy || !youtubeUrl.trim()}
            className="min-h-12 rounded-xl bg-cyan-300 px-5 text-sm font-bold text-slate-950 disabled:opacity-50"
          >
            {busy ? "Loading transcript…" : "Load embedded source"}
          </button>
        </form>

        <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/60 p-4">
          <div>
            <h2 className="text-lg font-bold text-white">Start from an uploaded source</h2>
            <p className="mt-1 text-sm leading-relaxed text-slate-400">
                Select your authorized MP4/WebM source (up to 500 MB) to transcribe with Deepgram, edit, render, and publish a trailer.
            </p>
          </div>
          <input
            type="file"
            accept="video/mp4,video/webm,.mp4,.webm"
            onChange={(event) => void handleSourceFile(event.currentTarget.files?.[0], event.currentTarget)}
            disabled={busy}
            className="block min-h-12 w-full text-base text-slate-300 file:mr-3 file:min-h-12 file:rounded-lg file:border-0 file:bg-slate-700 file:px-4 file:text-sm file:font-semibold file:text-white"
          />
          <p className="text-xs leading-relaxed text-slate-500">
            The source stays in this browser when storage allows. If it cannot be saved locally, transcription still runs and the source remains available until this page is closed.
          </p>
        </div>
      </section>}

      {loading ? (
        <p className="py-8 text-center text-sm text-slate-400">Loading saved trailer projects…</p>
      ) : catalog && catalog.trailers.length > 0 ? (
        <section className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-bold text-white">Saved trailers</h2>
            {project && (
              <button type="button" onClick={resetEditor} className="min-h-12 rounded-lg border border-slate-700 px-4 text-sm font-semibold text-slate-200">
                New trailer
              </button>
            )}
          </div>
          <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {catalog.trailers.map((trailer) => (
              <li key={trailer.slug} className="flex min-w-0 items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/60 p-2">
                <button
                  type="button"
                  onClick={() => void openProject(trailer.slug)}
                  disabled={busy}
                  className="min-h-12 min-w-0 flex-1 truncate rounded-lg px-3 text-left text-sm font-semibold text-slate-200 disabled:opacity-50"
                >
                  {trailer.title}
                </button>
                <span className="shrink-0 text-[10px] text-slate-500">
                  {trailer.status === "published" ? "Published" : "Draft"} · {new Date(trailer.updatedAt).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {project && (
        <section className="space-y-5 rounded-2xl border border-cyan-900/60 bg-slate-900/40 p-4 sm:p-6">
          <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-cyan-300">Editable trailer project</p>
              <label className="mt-2 block">
                <span className="sr-only">Trailer project title</span>
                <input
                  type="text"
                  value={project.title}
                  maxLength={120}
                  onChange={(event) => setProject({ ...project, title: event.target.value })}
                  className="min-h-12 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 text-xl font-bold text-white sm:text-2xl"
                />
              </label>
              <p className="mt-2 text-sm text-slate-400">
                {project.source.videoId ? `YouTube embed · ${project.source.videoTitle}` : `Uploaded source · ${project.source.uploadedFileName ?? "video file"}`}
                {project.source.uploadedFileName ? " · source uploaded" : " · preview only"}
                {isPublished ? " · published" : ""}
              </p>
              {isPublished && (
                <a
                  href={`/library/trailers/${encodeURIComponent(project.slug)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-flex min-h-12 items-center text-sm font-semibold text-emerald-300"
                >
                  Open published trailer
                </a>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void saveProject()}
                disabled={busy}
                className="min-h-12 rounded-xl bg-cyan-300 px-4 text-sm font-bold text-slate-950 disabled:opacity-50"
              >
                Save draft
              </button>
              {isPublished && (
                <button
                  type="button"
                  onClick={() => void unpublishProject()}
                  disabled={busy}
                  className="min-h-12 rounded-xl border border-amber-900 px-4 text-sm font-semibold text-amber-200 disabled:opacity-50"
                >
                  Unpublish
                </button>
              )}
              {catalog?.trailers.some((trailer) => trailer.slug === project.slug) && !isPublished && (
                <button
                  type="button"
                  onClick={() => void deleteProject()}
                  disabled={busy}
                  className="min-h-12 rounded-xl border border-rose-900 px-4 text-sm font-semibold text-rose-200 disabled:opacity-50"
                >
                  Delete
                </button>
              )}
            </div>
          </header>

          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(20rem,0.85fr)]">
            <div className="space-y-4">
              <TrailerVideoPreview
                project={project}
                localVideoUrl={localVideoUrl}
                playRequest={playRequest}
                seekRequest={seekRequest}
                activeMoment={activeMoment}
                onActiveMomentChange={handleActiveMomentChange}
                onCurrentTimeChange={handleCurrentTimeChange}
                onCropChange={handleCropChange}
                onError={handlePreviewError}
              />
              <p className="text-xs leading-relaxed text-slate-500">
                {localVideoUrl
                  ? "The uploaded source powers local montage playback and rendering. Captions already baked into its video pixels cannot be removed."
                  : "YouTube stays embedded and may buffer between moments. Trailer Studio hides supported controls, annotations, and captions; YouTube may still briefly show its title or related-video overlays when seeking, which embeds cannot fully disable."}
              </p>
              <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                <div>
                  <h3 className="font-bold text-white">Framing and crop</h3>
                  <p className="mt-1 text-xs text-slate-400">
                    Moment {activeMoment + 1} · Slot {Math.max(1, selectedSlotIndex + 1)} of {activeFrameSlots.length}
                  </p>
                </div>
                {selectedMoment && selectedFrame && selectedSlot && (
                  <>
                    <label className="block text-sm font-semibold text-slate-300">
                      Playhead · {previewTime.toFixed(1)}s
                      <input
                        type="range"
                        min={selectedMoment.startSeconds}
                        max={selectedMoment.endSeconds}
                        step="0.05"
                        value={Math.max(selectedMoment.startSeconds, Math.min(selectedMoment.endSeconds, previewTime))}
                        onChange={(event) => seekPreview(Number(event.target.value))}
                        className="mt-2 min-h-12 w-full accent-cyan-300"
                        aria-label="Seek within the selected trailer moment"
                      />
                    </label>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => setKeyframeAtTime(previewTime, selectedFrame)}
                        className="min-h-12 rounded-lg bg-cyan-300 px-4 text-sm font-bold text-slate-950"
                      >
                        Save position at playhead
                      </button>
                      <button
                        type="button"
                        onClick={splitFrameSlot}
                        className="min-h-12 rounded-lg border border-cyan-800 px-4 text-sm font-semibold text-cyan-100"
                      >
                        Split framing slot here
                      </button>
                    </div>
                  </>
                )}
                <label className="block text-sm font-semibold text-slate-300">
                  Screen preset · applies to every trailer moment
                  <select
                    value={selectedScreenPreset}
                    onChange={(event) => {
                      const preset = SCREEN_PRESETS.find((item) => item.id === event.target.value);
                      if (preset) applyScreenPreset(ShortAspectRatioSchema.parse(preset.aspectRatio));
                    }}
                    className="mt-2 min-h-12 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-base text-white"
                  >
                    <option value="custom" disabled>Custom per-slot framing</option>
                    {SCREEN_PRESETS.map((preset) => (
                      <option key={preset.id} value={preset.id}>{preset.label} · {preset.aspectRatio}</option>
                    ))}
                  </select>
                </label>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block text-sm font-semibold text-slate-300">
                    Aspect ratio
                    <select
                      value={selectedSlot?.aspectRatio ?? project.aspectRatio}
                      onChange={(event) => updateActiveFrameAspectRatio(ShortAspectRatioSchema.parse(event.target.value))}
                      className="mt-2 min-h-12 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-base text-white"
                    >
                      {ShortAspectRatioSchema.options.map((ratio) => (
                        <option key={ratio} value={ratio}>
                          {ratio === "9:16" ? "9:16 vertical" : ratio === "4:5" ? "4:5 portrait" : ratio === "1:1" ? "1:1 square" : "16:9 landscape"}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="space-y-2">
                    <span className="block text-sm font-semibold text-slate-300">Video fit</span>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        aria-pressed={selectedFrame?.fit === "contain"}
                        onClick={() => selectedFrame && setKeyframeAtTime(
                          previewTime,
                          { x: selectedFrame.x, y: selectedFrame.y, zoom: selectedFrame.zoom, fit: "contain" },
                          true,
                        )}
                        className={`min-h-12 rounded-lg border px-3 text-sm font-semibold ${selectedFrame?.fit === "contain" ? "border-cyan-400 bg-cyan-950 text-cyan-100" : "border-slate-700 text-slate-300"}`}
                      >
                        Show full video
                      </button>
                      <button
                        type="button"
                        aria-pressed={selectedFrame?.fit === "cover"}
                        onClick={() => selectedFrame && setKeyframeAtTime(
                          previewTime,
                          { x: selectedFrame.x, y: selectedFrame.y, zoom: selectedFrame.zoom, fit: "cover" },
                          true,
                        )}
                        className={`min-h-12 rounded-lg border px-3 text-sm font-semibold ${selectedFrame?.fit === "cover" ? "border-cyan-400 bg-cyan-950 text-cyan-100" : "border-slate-700 text-slate-300"}`}
                      >
                        Fill frame
                      </button>
                      <button
                        type="button"
                        onClick={() => setKeyframeAtTime(previewTime, { x: 50, y: 50, zoom: 1 })}
                        className="min-h-12 rounded-lg border border-slate-700 px-3 text-sm font-semibold text-slate-300"
                      >
                        Reset crop
                      </button>
                    </div>
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  {([
                    ["x", "Horizontal framing"],
                    ["y", "Vertical framing"],
                    ["zoom", "Zoom"],
                  ] as const).map(([field, label]) => (
                    <label key={field} className="block text-sm font-semibold text-slate-300">
                      {label}
                      <input
                        type="range"
                        min={field === "zoom" ? 1 : 0}
                        max={field === "zoom" ? 3 : 100}
                        step={field === "zoom" ? 0.05 : 1}
                        value={selectedFrame?.[field] ?? (field === "zoom" ? project.zoom : 50)}
                        onChange={(event) => {
                          const value = Number(event.target.value);
                          setKeyframeAtTime(previewTime, { [field]: value });
                        }}
                        className="mt-2 min-h-12 w-full accent-cyan-300"
                      />
                    </label>
                  ))}
                </div>
              </section>

              <section className="space-y-3 rounded-xl border border-violet-900/70 bg-violet-950/15 p-4">
                <div>
                  <h3 className="font-bold text-white">AI soundtrack suggestions</h3>
                  <p className="mt-1 text-xs leading-relaxed text-slate-400">
                    AI matches instrumental Jamendo tracks to your transcript and direction. Tracks are editable, loop to the trailer length, and duck under speech.
                  </p>
                </div>
                <label className="block text-sm font-semibold text-slate-300">
                  Music direction
                  <textarea
                    value={soundtrackMood}
                    onChange={(event) => setSoundtrackMood(event.target.value)}
                    maxLength={1000}
                    rows={2}
                    className="mt-2 min-h-20 w-full rounded-xl border border-slate-700 bg-slate-900 p-3 text-base text-white"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => void findSoundtrackSuggestions()}
                  disabled={musicSearchBusy || project.musicTracks.length >= 5}
                  className="min-h-12 w-full rounded-xl bg-violet-300 px-4 text-sm font-bold text-slate-950 disabled:opacity-50"
                >
                  {musicSearchBusy ? "Finding soundtrack…" : "Suggest soundtracks with AI"}
                </button>
                {soundtrackSuggestions.length > 0 && (
                  <ul className="space-y-3">
                    {soundtrackSuggestions.map((suggestion) => (
                      <li key={suggestion.id} className="space-y-2 rounded-lg border border-slate-800 bg-slate-950/70 p-3">
                        <div>
                          <p className="font-semibold text-white">{suggestion.title}</p>
                          <p className="text-xs text-slate-400">{suggestion.artistName} · {suggestion.query}</p>
                        </div>
                        <p className="text-xs leading-relaxed text-slate-400">{suggestion.reason}</p>
                        <audio
                          controls
                          preload="none"
                          src={suggestion.audioUrl}
                          aria-label={`Preview ${suggestion.title} by ${suggestion.artistName}`}
                          className="min-h-12 w-full"
                        />
                        <div className="flex flex-wrap items-center gap-3 text-xs text-violet-200">
                          <a href={suggestion.providerPageUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-12 items-center underline underline-offset-2">
                            Track details
                          </a>
                          <a href={suggestion.licenseUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-12 items-center underline underline-offset-2">
                            License terms
                          </a>
                          <button
                            type="button"
                            onClick={() => addSoundtrack(suggestion)}
                            disabled={project.musicTracks.length >= 5}
                            className="min-h-12 rounded-lg border border-violet-700 px-4 font-semibold disabled:opacity-50"
                          >
                            Add to trailer
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                {project.musicTracks.length > 0 && (
                  <ul className="space-y-3">
                    {project.musicTracks.map((track) => (
                      <li key={track.id} className="space-y-3 rounded-lg border border-violet-900/60 bg-slate-950/70 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate font-semibold text-white">{track.fileName}</p>
                            <a href={track.providerPageUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-12 items-center text-xs text-violet-200 underline underline-offset-2">
                              {track.creatorName} · Jamendo
                            </a>
                          </div>
                          <button
                            type="button"
                            onClick={() => setProject({
                              ...project,
                              musicTracks: project.musicTracks.filter((item) => item.id !== track.id),
                            })}
                            aria-label={`Remove soundtrack ${track.fileName}`}
                            className="min-h-12 min-w-12 rounded-lg border border-rose-900 px-3 text-rose-200"
                          >
                            Remove
                          </button>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-3">
                          {([
                            ["volume", "Volume", 0, 1, 0.01],
                            ["fadeInSeconds", "Fade in (seconds)", 0, 10, 0.1],
                            ["fadeOutSeconds", "Fade out (seconds)", 0, 10, 0.1],
                          ] as const).map(([field, label, min, max, step]) => (
                            <label key={field} className="block text-xs font-semibold text-slate-300">
                              {label}: {track[field].toFixed(field === "volume" ? 2 : 1)}
                              <input
                                type="range"
                                min={min}
                                max={max}
                                step={step}
                                value={track[field]}
                                onChange={(event) => updateSoundtrack(track.id, { [field]: Number(event.target.value) })}
                                className="mt-1 min-h-12 w-full accent-violet-300"
                              />
                            </label>
                          ))}
                        </div>
                        <label className="flex min-h-12 items-center gap-3 text-sm text-slate-300">
                          <input
                            type="checkbox"
                            checked={track.duckUnderSpeech}
                            onChange={(event) => updateSoundtrack(track.id, { duckUnderSpeech: event.target.checked })}
                            className="min-h-6 min-w-6 accent-violet-300"
                          />
                          Lower music while transcript dialogue is active
                        </label>
                        <label className="flex min-h-12 items-center gap-3 rounded-lg border border-amber-900/70 bg-amber-950/20 px-3 text-xs leading-relaxed text-amber-100">
                          <input
                            type="checkbox"
                            checked={track.commercialLicenseConfirmed}
                            onChange={(event) => updateSoundtrack(track.id, {
                              commercialLicenseConfirmed: event.target.checked,
                            })}
                            className="min-h-6 min-w-6 accent-amber-400"
                          />
                          I obtained the commercial license for public use of this track.
                        </label>
                        {!track.commercialLicenseConfirmed && (
                          <p className="text-xs text-amber-200">
                            Public publishing is blocked until you obtain the track license and confirm it here.{" "}
                            <a href={track.licenseUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">Review license</a>
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                <h3 className="font-bold text-white">Trailer copy</h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  {([
                    ["headline", "Headline", "Main message"],
                    ["brandLine", "Brand / organization", "Your name or brand"],
                    ["callToAction", "Call to action", "Join us · Learn more"],
                  ] as const).map(([field, label, placeholder]) => (
                    <label key={field} className="block text-sm font-semibold text-slate-300">
                      {label}
                      <input
                        type="text"
                        value={project[field]}
                        maxLength={field === "brandLine" ? 80 : 120}
                        placeholder={placeholder}
                        onChange={(event) => setProject({ ...project, [field]: event.target.value })}
                        className="mt-2 min-h-12 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-base text-white placeholder:text-slate-500"
                      />
                    </label>
                  ))}
                </div>
              </section>
            </div>

            <div className="space-y-4">
              <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                <div>
                  <h3 className="font-bold text-white">AI moment curation</h3>
                  <p className="mt-1 text-sm leading-relaxed text-slate-400">
                    AI proposes a sequence from transcript text and exact timestamps. You can edit, reorder, or remove every moment.
                  </p>
                </div>
                <label className="block text-sm font-semibold text-slate-300">
                  Direction for the AI
                  <textarea
                    value={editorDirection}
                    onChange={(event) => setEditorDirection(event.target.value)}
                    maxLength={4000}
                    rows={3}
                    placeholder="Audience, tone, message, or campaign goal"
                    className="mt-2 min-h-24 w-full rounded-xl border border-slate-700 bg-slate-900 p-3 text-base text-white placeholder:text-slate-500"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => void curateMoments()}
                  disabled={busy || project.transcript.length === 0}
                  className="min-h-12 w-full rounded-xl bg-violet-300 px-4 text-sm font-bold text-slate-950 disabled:opacity-50"
                >
                  {busy ? "Curating…" : "Generate trailer sequence"}
                </button>
                {project.transcript.length === 0 && (
                  <p className="text-xs text-amber-200">No transcript is saved for this project, so AI curation is unavailable. You can still add moments manually.</p>
                )}
                {project.source.uploadedFileName && (
                  <button
                    type="button"
                    onClick={() => void retranscribeSource()}
                    disabled={busy || !sourceFileReady}
                    className="min-h-12 rounded-lg border border-slate-700 px-4 text-sm font-semibold text-slate-200 disabled:opacity-50"
                  >
                    {project.transcript.length === 0 ? "Transcribe uploaded source" : "Refresh transcript from source"}
                  </button>
                )}
              </section>

              <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="font-bold text-white">Moment sequence</h3>
                    <p className="mt-1 text-xs text-slate-400">
                      {project.moments.length} moments · {project.moments.reduce((total, moment) => total + moment.endSeconds - moment.startSeconds, 0).toFixed(1)} seconds assembled
                    </p>
                  </div>
                </div>
                <ol className="space-y-3">
                  {project.moments.map((moment, index) => (
                    <li
                      key={moment.id}
                      className={`space-y-3 rounded-xl border p-3 ${
                        activeMoment === index ? "border-cyan-700 bg-cyan-950/20" : "border-slate-800 bg-slate-900/50"
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs font-bold uppercase tracking-wide text-cyan-200">Moment {index + 1}</span>
                        <div className="flex gap-1">
                          <button type="button" onClick={() => playFromMoment(index)} className="min-h-12 rounded-lg border border-cyan-800 px-3 text-xs font-semibold text-cyan-100">Preview from here</button>
                          <button type="button" onClick={() => moveMoment(index, -1)} disabled={index === 0} aria-label={`Move moment ${index + 1} earlier`} className="min-h-12 min-w-12 rounded-lg border border-slate-700 text-sm text-white disabled:opacity-40">↑</button>
                          <button type="button" onClick={() => moveMoment(index, 1)} disabled={index === project.moments.length - 1} aria-label={`Move moment ${index + 1} later`} className="min-h-12 min-w-12 rounded-lg border border-slate-700 text-sm text-white disabled:opacity-40">↓</button>
                          <button type="button" onClick={() => removeMoment(index)} aria-label={`Remove moment ${index + 1}`} className="min-h-12 min-w-12 rounded-lg border border-rose-900 text-sm text-rose-200">×</button>
                        </div>
                      </div>
                      <div className="grid gap-2 sm:grid-cols-2">
                        <label className="text-xs font-semibold text-slate-400">
                          In (seconds)
                          <input
                            type="number"
                            min={0}
                            max={project.sourceDurationSeconds}
                            step="0.1"
                            value={moment.startSeconds}
                            onChange={(event) => updateMoment(index, { startSeconds: Number(event.target.value) })}
                            className="mt-1 min-h-12 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-base text-white"
                          />
                        </label>
                        <label className="text-xs font-semibold text-slate-400">
                          Out (seconds)
                          <input
                            type="number"
                            min={0}
                            max={project.sourceDurationSeconds}
                            step="0.1"
                            value={moment.endSeconds}
                            onChange={(event) => updateMoment(index, { endSeconds: Number(event.target.value) })}
                            className="mt-1 min-h-12 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-base text-white"
                          />
                        </label>
                      </div>
                      <div className="grid gap-2 sm:grid-cols-2">
                        <label className="text-xs font-semibold text-slate-400">
                          Entrance
                          <select
                            value={moment.transitionIn}
                            onChange={(event) => updateMoment(index, {
                              transitionIn: TrailerTransitionSchema.parse(event.target.value),
                            })}
                            className="mt-1 min-h-12 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-base text-white"
                          >
                            {TRANSITION_OPTIONS.map((transition) => (
                              <option key={transition.id} value={transition.id}>{transition.label}</option>
                            ))}
                          </select>
                        </label>
                        <label className="text-xs font-semibold text-slate-400">
                          Exit
                          <select
                            value={moment.transitionOut}
                            onChange={(event) => updateMoment(index, {
                              transitionOut: TrailerTransitionSchema.parse(event.target.value),
                            })}
                            className="mt-1 min-h-12 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-base text-white"
                          >
                            {TRANSITION_OPTIONS.map((transition) => (
                              <option key={transition.id} value={transition.id}>{transition.label}</option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <label className="block text-xs font-semibold text-slate-400">
                        Transition duration · {moment.transitionDurationSeconds.toFixed(1)}s
                        <input
                          type="range"
                          min={0.1}
                          max={3}
                          step={0.1}
                          value={moment.transitionDurationSeconds}
                          onChange={(event) => updateMoment(index, {
                            transitionDurationSeconds: Number(event.target.value),
                          })}
                          className="mt-1 min-h-12 w-full accent-cyan-300"
                        />
                      </label>
                      <label className="block text-xs font-semibold text-slate-400">
                        Scene title
                        <input
                          type="text"
                          value={moment.title}
                          maxLength={100}
                          onChange={(event) => updateMoment(index, { title: event.target.value })}
                          className="mt-1 min-h-12 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-base text-white"
                        />
                      </label>
                      <label className="block text-xs font-semibold text-slate-400">
                        Spoken hook / on-screen line
                        <textarea
                          value={moment.hook}
                          maxLength={240}
                          rows={2}
                          onChange={(event) => updateMoment(index, { hook: event.target.value })}
                          className="mt-1 min-h-20 w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-base text-white"
                        />
                      </label>
                      {moment.reason && <p className="text-xs leading-relaxed text-slate-500">{moment.reason}</p>}
                    </li>
                  ))}
                </ol>
                <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                  <label className="text-xs font-semibold text-slate-400">
                    New in (seconds)
                    <input type="number" min={0} step="0.1" value={manualStart} onChange={(event) => setManualStart(event.target.value)} className="mt-1 min-h-12 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-base text-white" />
                  </label>
                  <label className="text-xs font-semibold text-slate-400">
                    New out (seconds)
                    <input type="number" min={0} step="0.1" value={manualEnd} onChange={(event) => setManualEnd(event.target.value)} className="mt-1 min-h-12 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-base text-white" />
                  </label>
                  <button type="button" onClick={addManualMoment} disabled={project.moments.length >= 24} className="min-h-12 self-end rounded-lg border border-slate-700 px-4 text-sm font-semibold text-slate-200 disabled:opacity-50">
                    Add moment
                  </button>
                </div>
                {selectedMoment && <p className="text-xs text-slate-500">Selected: {formatTime(selectedMoment.startSeconds)}–{formatTime(selectedMoment.endSeconds)}</p>}
              </section>

              {project.source.videoId && !project.source.uploadedFileName && (
                <section className="space-y-3 rounded-xl border border-amber-900/60 bg-amber-950/20 p-4">
                  <div>
                    <h3 className="font-bold text-amber-100">Upload source to enable export</h3>
                    <p className="mt-1 text-sm leading-relaxed text-amber-100/70">
                      YouTube stays embedded for preview. Upload the matching source video that you own or are authorized to use to enable local export.
                    </p>
                  </div>
                  <input
                    type="file"
                    accept="video/mp4,video/webm,.mp4,.webm"
                    onChange={(event) => void handleSourceFile(event.currentTarget.files?.[0], event.currentTarget)}
                    disabled={busy}
                    className="block min-h-12 w-full text-base text-slate-300 file:mr-3 file:min-h-12 file:rounded-lg file:border-0 file:bg-slate-700 file:px-4 file:text-sm file:font-semibold file:text-white"
                  />
                </section>
              )}

              {project.source.uploadedFileName && (
                <section className="space-y-3 rounded-xl border border-emerald-900/70 bg-emerald-950/20 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h3 className="font-bold text-emerald-100">Render and publish</h3>
                      <p className="mt-1 text-xs text-slate-400">{project.source.uploadedFileName} · {sourceFileReady ? "available on this device" : "re-select source to export"}</p>
                    </div>
                    <input
                      type="file"
                      accept="video/mp4,video/webm,.mp4,.webm"
                      onChange={(event) => void handleSourceFile(event.currentTarget.files?.[0], event.currentTarget)}
                      disabled={busy}
                      aria-label="Re-select uploaded source video"
                      className="min-h-12 max-w-full text-xs text-slate-300 file:mr-2 file:min-h-12 file:rounded-lg file:border-0 file:bg-slate-700 file:px-3 file:text-xs file:font-semibold file:text-white"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => void exportProject()}
                    disabled={busy || !canExport}
                    className="min-h-12 w-full rounded-xl bg-emerald-300 px-4 text-sm font-extrabold text-slate-950 disabled:opacity-50 sm:w-auto"
                  >
                    {exportProgress === null ? "Render trailer" : `Rendering ${Math.round(exportProgress * 100)}%`}
                  </button>
                  {exportProgress !== null && (
                    <div
                      role="progressbar"
                      aria-label="Trailer export progress"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(exportProgress * 100)}
                      className="h-2 overflow-hidden rounded-full bg-slate-800"
                    >
                      <div className="h-full bg-emerald-300 transition-[width]" style={{ width: `${exportProgress * 100}%` }} />
                    </div>
                  )}
                  {downloadUrl && hasCurrentExport && (
                    <a href={downloadUrl} download={downloadName} className="flex min-h-12 items-center justify-center rounded-lg border border-emerald-700 px-4 text-sm font-bold text-emerald-100 sm:w-auto">
                      Download {downloadName}
                    </a>
                  )}
                  {project.source.videoId && (
                    <button
                      type="button"
                      onClick={() => void publishProject("youtube")}
                      disabled={busy || !canPublishEmbedded}
                      className="min-h-12 w-full rounded-xl border border-cyan-700 px-4 text-sm font-extrabold text-cyan-100 disabled:opacity-50 sm:w-auto"
                    >
                      Publish embedded YouTube trailer
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void publishProject("upload")}
                    disabled={busy || !canPublishRendered}
                    className="min-h-12 w-full rounded-xl bg-cyan-300 px-4 text-sm font-extrabold text-slate-950 disabled:opacity-50 sm:w-auto"
                  >
                    {isPublished ? "Update rendered trailer" : "Publish rendered trailer"}
                  </button>
                  {!hasCurrentExport && !canPublishEmbedded && (
                    <p className="text-xs text-amber-200">
                      Render the latest edits before publishing. The published page plays one continuous video file.
                    </p>
                  )}
                  <p className="text-xs leading-relaxed text-slate-500">
                    Publish the YouTube moments as an embedded sequence without uploading a source file, or render and publish a single video file.
                  </p>
                </section>
              )}
              {!project.source.uploadedFileName && (
                <section className="space-y-3 rounded-xl border border-emerald-900/70 bg-emerald-950/20 p-4">
                  <h3 className="font-bold text-emerald-100">Publish your trailer</h3>
                  <p className="text-sm leading-relaxed text-slate-300">
                    Publish this edited sequence directly as a YouTube embed. Upload an authorized source only if you also want to render and publish a single downloadable video file.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void exportProject()}
                      disabled={busy || !canExport}
                      className="min-h-12 rounded-xl bg-emerald-300 px-4 text-sm font-extrabold text-slate-950 disabled:opacity-50"
                    >
                      Render video file
                    </button>
                    <button
                      type="button"
                      onClick={() => void publishProject("youtube")}
                      disabled={busy || !canPublishEmbedded}
                      className="min-h-12 rounded-xl bg-cyan-300 px-4 text-sm font-extrabold text-slate-950 disabled:opacity-50"
                    >
                      Publish embedded video
                    </button>
                  </div>
                </section>
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
