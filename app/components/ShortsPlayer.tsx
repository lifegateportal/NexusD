"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent } from "react";
import type { ShortProject, ShortCropKeyframe, ShortFrameSlot, ShortOverlay } from "@/lib/schemas/video-short";
import { buildTimedCaptionCues } from "@/lib/short-caption-cues";
import {
  getRemovedTranscriptWordIndexes,
  getTranscriptCutAtTime,
} from "@/lib/short-transcript-edits";

type YouTubePlayerInstance = {
  destroy(): void;
  getCurrentTime(): number;
  getIframe(): HTMLIFrameElement;
  getPlayerState(): number;
  unloadModule(moduleName: string): void;
  pauseVideo(): void;
  playVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
};

type YouTubeApi = {
  Player: new (
    element: HTMLElement,
    options: Record<string, unknown>,
  ) => YouTubePlayerInstance;
  PlayerState: { PLAYING: number };
};

declare global {
  interface Window {
    YT?: YouTubeApi;
    onYouTubeIframeAPIReady?: () => void;
  }
}

type Props = {
  project: ShortProject;
  localVideoUrl?: string | null;
  editable?: boolean;
  compactPreview?: boolean;
  onTimeChange?: (seconds: number) => void;
  seekRequestSeconds?: number | null;
  onCropChange?: (timeSeconds: number, x: number, y: number, zoom: number, fit: ShortCropKeyframe["fit"]) => void;
  onOverlayChange?: (id: string, patch: Partial<ShortOverlay>) => void;
  embedMode?: boolean;
  showErrors?: boolean;
};

type PreviewStyle = CSSProperties & {
  "--preview-width-mobile"?: string;
  "--preview-width-desktop"?: string;
};

let youtubeApiPromise: Promise<void> | null = null;

function loadYouTubeApi(): Promise<void> {
  if (typeof window.YT?.Player === "function") return Promise.resolve();
  if (!youtubeApiPromise) {
    youtubeApiPromise = new Promise((resolve, reject) => {
      const previousCallback = window.onYouTubeIframeAPIReady;
      const timeout = window.setTimeout(() => reject(new Error("YouTube player API did not load.")), 15000);
      window.onYouTubeIframeAPIReady = () => {
        try {
          previousCallback?.();
        } finally {
          window.clearTimeout(timeout);
          resolve();
        }
      };
      let script = document.querySelector<HTMLScriptElement>("script[data-youtube-iframe-api]");
      if (!script) {
        script = document.createElement("script");
        script.src = "https://www.youtube.com/iframe_api";
        script.dataset.youtubeIframeApi = "true";
        script.onerror = () => {
          window.clearTimeout(timeout);
          reject(new Error("Could not load the YouTube player API."));
        };
        document.head.appendChild(script);
      }
    });
  }
  return youtubeApiPromise;
}

function framePosition(slot: ShortFrameSlot, timeSeconds: number): ShortCropKeyframe {
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

function aspectValue(value: ShortFrameSlot["aspectRatio"]): number {
  const [width, height] = value.split(":").map(Number);
  return width / height;
}

function colorWithOpacity(color: string, opacity: number): string {
  if (color === "transparent") return "transparent";
  const channels = color.match(/[A-Fa-f0-9]{2}/g);
  if (!channels || channels.length !== 3) return "transparent";
  const [red, green, blue] = channels.map((channel) => Number.parseInt(channel, 16));
  return `rgba(${red}, ${green}, ${blue}, ${opacity})`;
}

export default function ShortsPlayer({
  project,
  localVideoUrl,
  editable = false,
  compactPreview = false,
  onTimeChange,
  seekRequestSeconds,
  onCropChange,
  onOverlayChange,
  embedMode = false,
  showErrors = true,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const youtubeHostRef = useRef<HTMLDivElement>(null);
  const youtubePlayerRef = useRef<YouTubePlayerInstance | null>(null);
  const fullscreenContainerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const brollVideoRefs = useRef(new Map<string, HTMLVideoElement>());
  const musicTrackRefs = useRef(new Map<string, HTMLAudioElement>());
  const musicTrackIdsRef = useRef(new Set(project.musicTracks.map((track) => track.id)));
  const transcriptCutsRef = useRef(
    project.source.type === "upload" ? [...project.transcriptCuts, ...project.pauseCuts] : [],
  );
  const lastSkippedCutIdRef = useRef<string | null>(null);
  const requireUserPlayAfterMusicAddRef = useRef(false);
  const overlayDragRef = useRef<{
    id: string;
    mode: "move" | "resize";
    clientX: number;
    clientY: number;
    stageWidth: number;
    stageHeight: number;
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const timeCallbackRef = useRef(onTimeChange);
  const dragRef = useRef<{ x: number; y: number; clientX: number; clientY: number; width: number; height: number } | null>(null);
  const [currentTime, setCurrentTime] = useState(project.startSeconds);
  const [duration, setDuration] = useState(project.endSeconds);
  const [playing, setPlaying] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [youtubeReady, setYoutubeReady] = useState(false);
  const [playerError, setPlayerError] = useState("");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenControlsVisible, setFullscreenControlsVisible] = useState(true);
  const [shareStatus, setShareStatus] = useState("");
  const [shareError, setShareError] = useState("");

  timeCallbackRef.current = onTimeChange;
  transcriptCutsRef.current = project.source.type === "upload"
    ? [...project.transcriptCuts, ...project.pauseCuts]
    : [];

  const activeSlot = project.frameSlots.find((slot) =>
    currentTime >= slot.startSeconds && currentTime <= slot.endSeconds,
  ) ?? project.frameSlots[0];
  const position = framePosition(activeSlot, currentTime);
  const ratio = aspectValue(activeSlot.aspectRatio);
  const videoUrl = project.source.type === "upload"
    ? localVideoUrl || project.source.sourceUrl || null
    : null;
  const sourceIdentity = project.source.type === "youtube"
    ? project.source.videoId
    : project.source.sourceUrl ?? "";
  const removedWordIndexes = useMemo(
    () => getRemovedTranscriptWordIndexes(project.source.type === "upload" ? project.transcriptCuts : []),
    [project.source.type, project.transcriptCuts],
  );
  const timedCaptions = useMemo(
    () => buildTimedCaptionCues(project.captions, removedWordIndexes),
    [project.captions, removedWordIndexes],
  );
  const activeTimedCaption = timedCaptions.find((caption) =>
    currentTime >= caption.startSeconds && currentTime < caption.endSeconds,
  );
  const activeOverlays = project.overlays.filter((overlay) =>
    currentTime >= overlay.startSeconds && currentTime < overlay.endSeconds,
  ).sort((first, second) => first.zIndex - second.zIndex);

  useEffect(() => {
    setCurrentTime(project.startSeconds);
    setDuration(project.endSeconds);
  }, [project.startSeconds, project.endSeconds]);

  useEffect(() => {
    setHasStarted(false);
  }, [project.slug, project.thumbnailUrl, sourceIdentity]);

  useEffect(() => {
    const updateFullscreen = () => {
      setIsFullscreen(document.fullscreenElement === fullscreenContainerRef.current);
      setFullscreenControlsVisible(true);
    };
    document.addEventListener("fullscreenchange", updateFullscreen);
    return () => {
      document.removeEventListener("fullscreenchange", updateFullscreen);
    };
  }, []);

  useEffect(() => {
    if (!isFullscreen || !playing) {
      setFullscreenControlsVisible(true);
      return;
    }
    if (!fullscreenControlsVisible) return;
    const timer = window.setTimeout(() => setFullscreenControlsVisible(false), 2500);
    return () => window.clearTimeout(timer);
  }, [fullscreenControlsVisible, isFullscreen, playing]);

  useEffect(() => {
    setYoutubeReady(false);
    if (project.source.type !== "youtube") return;
    let timer: number | undefined;
    let disposed = false;
    const videoId = project.source.videoId;
    const startSeconds = project.startSeconds;
    const endSeconds = project.endSeconds;

    loadYouTubeApi().then(() => {
      if (disposed || !youtubeHostRef.current || !window.YT) return;
      youtubePlayerRef.current = new window.YT.Player(youtubeHostRef.current, {
        width: "100%",
        height: "100%",
        videoId,
        playerVars: {
          autoplay: 0,
          controls: 0,
          cc_load_policy: 0,
          enablejsapi: 1,
          fs: 1,
          playsinline: 1,
          rel: 0,
          start: Math.floor(startSeconds),
          origin: window.location.origin,
        },
        events: {
          onReady: () => {
            if (disposed) return;
            setYoutubeReady(true);
            const player = youtubePlayerRef.current;
            if (player) {
              const iframe = player.getIframe();
              iframe.style.position = "absolute";
              iframe.style.inset = "0";
              iframe.style.width = "100%";
              iframe.style.height = "100%";
              iframe.style.maxWidth = "none";
              iframe.style.border = "0";
              player.unloadModule("captions");
              player.seekTo(startSeconds, true);
            }
            timer = window.setInterval(() => {
              const player = youtubePlayerRef.current;
              if (!player) return;
              const time = player.getCurrentTime();
              if (!Number.isFinite(time)) return;
              const transcriptCut = getTranscriptCutAtTime(transcriptCutsRef.current, time);
              if (transcriptCut) {
                if (lastSkippedCutIdRef.current !== transcriptCut.id) {
                  lastSkippedCutIdRef.current = transcriptCut.id;
                  player.seekTo(transcriptCut.endSeconds, true);
                }
                setCurrentTime(transcriptCut.endSeconds);
                timeCallbackRef.current?.(transcriptCut.endSeconds);
                return;
              }
              lastSkippedCutIdRef.current = null;
              setCurrentTime(time);
              timeCallbackRef.current?.(time);
              if (time >= endSeconds) {
                player.pauseVideo();
                setPlaying(false);
              } else {
                setPlaying(player.getPlayerState() === window.YT?.PlayerState.PLAYING);
              }
            }, 80);
          },
          onApiChange: () => youtubePlayerRef.current?.unloadModule("captions"),
          onStateChange: () => youtubePlayerRef.current?.unloadModule("captions"),
          onError: () => setPlayerError("YouTube could not play this video in an embedded player."),
        },
      });
    }).catch((error: unknown) => {
      if (!disposed) setPlayerError(error instanceof Error ? error.message : "Could not load the YouTube player.");
    });

    return () => {
      disposed = true;
      if (timer !== undefined) window.clearInterval(timer);
      youtubePlayerRef.current?.destroy();
      youtubePlayerRef.current = null;
    };
  }, [project.source, project.startSeconds, project.endSeconds]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTimeUpdate = () => {
      const transcriptCut = getTranscriptCutAtTime(transcriptCutsRef.current, video.currentTime);
      if (transcriptCut) {
        video.currentTime = transcriptCut.endSeconds;
        setCurrentTime(transcriptCut.endSeconds);
        timeCallbackRef.current?.(transcriptCut.endSeconds);
        return;
      }
      setCurrentTime(video.currentTime);
      timeCallbackRef.current?.(video.currentTime);
      if (video.currentTime >= project.endSeconds) {
        video.pause();
        setPlaying(false);
      }
    };
    const onLoadedMetadata = () => {
      setDuration(Number.isFinite(video.duration) ? video.duration : project.endSeconds);
      video.currentTime = project.startSeconds;
    };
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("loadedmetadata", onLoadedMetadata);
    return () => {
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
    };
  }, [project.startSeconds, project.endSeconds, videoUrl]);

  useEffect(() => {
    if (seekRequestSeconds === undefined || seekRequestSeconds === null) return;
    const timeSeconds = Math.max(
      project.startSeconds,
      Math.min(project.endSeconds, seekRequestSeconds),
    );
    if (videoRef.current) videoRef.current.currentTime = timeSeconds;
    else youtubePlayerRef.current?.seekTo(timeSeconds, true);
    setCurrentTime(timeSeconds);
  }, [seekRequestSeconds, project.startSeconds, project.endSeconds]);

  const syncAuxiliaryMedia = useCallback((timeSeconds: number, shouldPlay: boolean) => {
    const speechActive = project.captions.some((caption) =>
      timeSeconds >= caption.startSeconds && timeSeconds < caption.endSeconds,
    ) && !getTranscriptCutAtTime(transcriptCutsRef.current, timeSeconds);

    for (const clip of project.brollClips) {
      const video = brollVideoRefs.current.get(clip.id);
      if (!video) continue;
      const active = timeSeconds >= clip.startSeconds && timeSeconds < clip.endSeconds;
      if (!active) {
        video.pause();
        continue;
      }
      const targetTime = Math.min(clip.sourceDurationSeconds, timeSeconds - clip.startSeconds);
      if (video.readyState >= 1 && Math.abs(video.currentTime - targetTime) > 0.4) {
        video.currentTime = targetTime;
      }
      if (shouldPlay && video.paused) {
        void video.play().catch(() => {
          setPlayerError("Could not play this B-roll clip. Check that the uploaded file is a supported MP4 or WebM.");
        });
      } else if (!shouldPlay) {
        video.pause();
      }
    }

    for (const track of project.musicTracks) {
      const audio = musicTrackRefs.current.get(track.id);
      if (!audio) continue;
      const audioShouldPlay = shouldPlay && !requireUserPlayAfterMusicAddRef.current;
      const active = timeSeconds >= track.startSeconds && timeSeconds < track.endSeconds;
      if (!active || !audioShouldPlay) {
        audio.pause();
        continue;
      }
      const elapsed = timeSeconds - track.startSeconds;
      const remaining = track.endSeconds - timeSeconds;
      const fadeInGain = track.fadeInSeconds > 0
        ? Math.min(1, elapsed / track.fadeInSeconds)
        : 1;
      const fadeOutGain = track.fadeOutSeconds > 0
        ? Math.min(1, remaining / track.fadeOutSeconds)
        : 1;
      const speechGain = track.duckUnderSpeech && speechActive ? track.duckVolume : 1;
      audio.volume = Math.max(0, Math.min(1, track.volume * fadeInGain * fadeOutGain * speechGain));
      if (audio.readyState >= 1 && Math.abs(audio.currentTime - elapsed) > 0.75) {
        audio.currentTime = elapsed;
      }
      if (audio.paused) {
        void audio.play().catch((error: unknown) => {
          if (error instanceof Error && error.name === "NotAllowedError") {
            setPlayerError("Your browser blocked music playback. Press Play to start the short and music together.");
            return;
          }
          setPlayerError("Could not play the instrumental track. Check its format and start playback with the Play button.");
        });
      } else if (!shouldPlay) {
        audio.pause();
      }
    }
  }, [project.brollClips, project.captions, project.musicTracks]);

  useEffect(() => {
    const currentTrackIds = new Set(project.musicTracks.map((track) => track.id));
    const addedTrack = [...currentTrackIds].some((id) => !musicTrackIdsRef.current.has(id));
    musicTrackIdsRef.current = currentTrackIds;
    if (!addedTrack || !playing) return;

    requireUserPlayAfterMusicAddRef.current = true;
    if (project.source.type === "youtube") youtubePlayerRef.current?.pauseVideo();
    else videoRef.current?.pause();
    setPlaying(false);
    setPlayerError("");
  }, [project.musicTracks, project.source.type, playing]);

  useEffect(() => {
    const shouldPlay = playing && !requireUserPlayAfterMusicAddRef.current;
    syncAuxiliaryMedia(currentTime, shouldPlay);
  }, [currentTime, playing, syncAuxiliaryMedia]);

  useEffect(() => {
    const video = videoRef.current;
    if (video && video.readyState >= 1) video.currentTime = project.startSeconds;
  }, [project.startSeconds, videoUrl]);

  function seek(seconds: number) {
    const requested = Math.max(project.startSeconds, Math.min(project.endSeconds, seconds));
    const bounded = getTranscriptCutAtTime(transcriptCutsRef.current, requested)?.endSeconds ?? requested;
    setCurrentTime(bounded);
    syncAuxiliaryMedia(bounded, playing);
    if (project.source.type === "youtube") youtubePlayerRef.current?.seekTo(bounded, true);
    else if (videoRef.current) videoRef.current.currentTime = bounded;
  }

  function togglePlayback() {
    setPlayerError("");
    const nextPlaying = !playing;
    if (nextPlaying && project.source.type === "youtube" && !youtubeReady) return;
    if (nextPlaying) requireUserPlayAfterMusicAddRef.current = false;
    const playbackTime = !playing && currentTime >= project.endSeconds
      ? project.startSeconds
      : currentTime;
    if (project.source.type === "youtube") {
      if (!playing && currentTime >= project.endSeconds) seek(project.startSeconds);
      if (playing) youtubePlayerRef.current?.pauseVideo();
      else {
        setHasStarted(true);
        youtubePlayerRef.current?.playVideo();
      }
      syncAuxiliaryMedia(playbackTime, nextPlaying);
      setPlaying(nextPlaying);
      return;
    }
    if (!videoRef.current) return;
    if (!playing && currentTime >= project.endSeconds) seek(project.startSeconds);
    if (playing) videoRef.current.pause();
    else {
      setHasStarted(true);
      void videoRef.current.play();
    }
    syncAuxiliaryMedia(playbackTime, nextPlaying);
    setPlaying(nextPlaying);
  }

  async function toggleFullscreen() {
    if (isFullscreen) {
      setFullscreenControlsVisible(true);
      if (!document.fullscreenElement) {
        setIsFullscreen(false);
        return;
      }
      try {
        await document.exitFullscreen();
      } catch {
        setPlayerError("The browser could not exit fullscreen mode.");
      }
      return;
    }

    setFullscreenControlsVisible(true);
    const container = fullscreenContainerRef.current;
    if (container?.requestFullscreen) {
      try {
        await container.requestFullscreen();
        return;
      } catch {
        setPlayerError("");
      }
    }
    setIsFullscreen(true);
  }

  async function shareShort() {
    const url = new URL(`/library/shorts/${encodeURIComponent(project.slug)}`, window.location.origin).toString();
    const shareData = {
      title: project.title,
      text: project.description || project.title,
      url,
    };
    setShareError("");
    setShareStatus("");
    if (navigator.share) {
      try {
        await navigator.share(shareData);
        setShareStatus("Short shared.");
        return;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") return;
      }
    }
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable in this browser.");
      await navigator.clipboard.writeText(url);
      setShareStatus("Short link copied. Paste it into any app.");
    } catch (error) {
      setShareError(error instanceof Error ? error.message : "Could not share or copy the short link.");
    }
  }

  async function copyEmbedLink() {
    const url = new URL(
      `/library/shorts/${encodeURIComponent(project.slug)}/embed`,
      window.location.origin,
    ).toString();
    setShareError("");
    setShareStatus("");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable in this browser.");
      await navigator.clipboard.writeText(url);
      setShareStatus("Player link copied. Paste it where embedded players are supported.");
    } catch (error) {
      setShareError(error instanceof Error ? error.message : "Could not copy the player link.");
    }
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!editable || !onCropChange) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    dragRef.current = {
      x: position.x,
      y: position.y,
      clientX: event.clientX,
      clientY: event.clientY,
      width: bounds.width,
      height: bounds.height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function startOverlayDrag(
    event: PointerEvent<HTMLDivElement | HTMLButtonElement>,
    overlay: ShortOverlay,
    mode: "move" | "resize",
  ) {
    if (!editable || isFullscreen || !onOverlayChange) return;
    event.preventDefault();
    event.stopPropagation();
    const stage = stageRef.current;
    const bounds = stage?.getBoundingClientRect();
    if (!stage || !bounds || bounds.width <= 0 || bounds.height <= 0) return;
    overlayDragRef.current = {
      id: overlay.id,
      mode,
      clientX: event.clientX,
      clientY: event.clientY,
      stageWidth: bounds.width,
      stageHeight: bounds.height,
      left: overlay.left,
      top: overlay.top,
      width: overlay.width,
      height: overlay.height,
    };
    stage.setPointerCapture(event.pointerId);
  }

  function moveOverlayDrag(event: PointerEvent<HTMLDivElement>) {
    const drag = overlayDragRef.current;
    if (!drag || !onOverlayChange) return;
    const deltaX = (event.clientX - drag.clientX) / drag.stageWidth * 100;
    const deltaY = (event.clientY - drag.clientY) / drag.stageHeight * 100;
    if (drag.mode === "move") {
      onOverlayChange(drag.id, {
        left: Math.max(0, Math.min(100 - drag.width, drag.left + deltaX)),
        top: Math.max(0, Math.min(100 - drag.height, drag.top + deltaY)),
      });
      return;
    }
    onOverlayChange(drag.id, {
      width: Math.max(1, Math.min(100 - drag.left, drag.width + deltaX)),
      height: Math.max(1, Math.min(100 - drag.top, drag.height + deltaY)),
    });
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || !onCropChange) return;
    const x = Math.max(0, Math.min(100, drag.x - ((event.clientX - drag.clientX) / drag.width) * 100));
    const y = Math.max(0, Math.min(100, drag.y - ((event.clientY - drag.clientY) / drag.height) * 100));
    onCropChange(currentTime, x, y, position.zoom, position.fit);
  }

  const sourceAspectRatio = 16 / 9;
  const widthAtFit = (position.fit === "cover"
    ? Math.max(100, (sourceAspectRatio / ratio) * 100)
    : Math.min(100, (sourceAspectRatio / ratio) * 100));
  const heightAtFit = (position.fit === "cover"
    ? Math.max(100, (ratio / sourceAspectRatio) * 100)
    : Math.min(100, (ratio / sourceAspectRatio) * 100));
  const playerWidthPercent = widthAtFit * position.zoom;
  const playerHeightPercent = heightAtFit * position.zoom;
  const playerLeftPercent = (100 - playerWidthPercent) * (position.x / 100);
  const playerTopPercent = (100 - playerHeightPercent) * (position.y / 100);
  const captionPosition = project.captionPosition === "top"
    ? "top-4"
    : project.captionPosition === "middle"
      ? "top-1/2 -translate-y-1/2"
      : "bottom-4";
  const legacyCaptionSize = project.captionSize === "small" ? 4.4 : project.captionSize === "large" ? 6.2 : 5.2;
  const captionFontSize = project.captionFontSize ?? legacyCaptionSize;
  const captionFontFamily = {
    sans: "ui-sans-serif, system-ui, sans-serif",
    condensed: '"Arial Narrow", "Roboto Condensed", sans-serif',
    rounded: 'ui-rounded, "Trebuchet MS", sans-serif',
    serif: 'Georgia, "Times New Roman", serif',
  }[project.captionFontFamily];
  const captionStyle = {
    "bold-box": {
      backgroundColor: colorWithOpacity(project.captionBackgroundColor, project.captionBackgroundOpacity),
      borderRadius: "0.35em",
      fontWeight: 800,
      textShadow: "0 1px 3px rgb(0 0 0 / 55%)",
    },
    clean: {
      backgroundColor: "transparent",
      borderRadius: "0",
      fontWeight: 700,
      textShadow: "0 2px 6px rgb(0 0 0 / 95%)",
    },
    outline: {
      backgroundColor: "transparent",
      borderRadius: "0",
      fontWeight: 900,
      textShadow: "0 2px 2px #000, 2px 0 2px #000, -2px 0 2px #000, 0 -2px 2px #000",
    },
    pill: {
      backgroundColor: colorWithOpacity(project.captionBackgroundColor, project.captionBackgroundOpacity),
      borderRadius: "999px",
      fontWeight: 800,
      textShadow: "0 1px 2px rgb(0 0 0 / 45%)",
    },
    minimal: {
      backgroundColor: "transparent",
      borderRadius: "0",
      fontWeight: 700,
      textShadow: "0 2px 8px rgb(0 0 0 / 95%)",
    },
  }[project.captionStyle];

  const previewStyle: PreviewStyle = isFullscreen
    ? {
      position: "fixed",
      inset: 0,
      zIndex: 100,
      width: "100vw",
      height: "100dvh",
      aspectRatio: "auto",
      borderRadius: 0,
    }
    : {
      aspectRatio: activeSlot.aspectRatio.replace(":", "/"),
      ...(embedMode ? {
        width: `min(100vw, ${ratio * 80}dvh)`,
      } : {}),
      ...(compactPreview ? {
        "--preview-width-mobile": `${ratio * 34}dvh`,
        "--preview-width-desktop": `${ratio * 60}dvh`,
      } : {}),
    };
  const sourceReady = project.source.type === "youtube" ? youtubeReady : Boolean(videoUrl);

  return (
    <div className={compactPreview || embedMode ? "flex w-full flex-col items-center" : "w-full"}>
      <div
        ref={fullscreenContainerRef}
        className={`relative touch-none overflow-hidden bg-black ${
          isFullscreen ? "flex items-center justify-center rounded-none" : "rounded-xl"
        } ${compactPreview ? "mx-auto w-[min(100%,var(--preview-width-mobile))] lg:w-[min(100%,var(--preview-width-desktop))]" : "w-full"} ${editable && !isFullscreen ? "cursor-move" : ""}`}
        style={previewStyle}
        onPointerDown={isFullscreen ? undefined : onPointerDown}
        onPointerMove={isFullscreen ? undefined : onPointerMove}
        onPointerUp={isFullscreen ? undefined : () => { dragRef.current = null; }}
        onPointerCancel={isFullscreen ? undefined : () => { dragRef.current = null; }}
        aria-label={editable && !isFullscreen ? "Drag the video to adjust its crop" : undefined}
      >
        <div
          ref={stageRef}
          className="relative h-full w-full overflow-hidden bg-black"
          style={{
            containerType: "inline-size",
            ...(isFullscreen ? {
              width: `min(100vw, ${ratio * 100}dvh)`,
              height: `min(100dvh, ${100 / ratio}vw)`,
            } : {}),
          }}
          onPointerMove={moveOverlayDrag}
          onPointerUp={() => { overlayDragRef.current = null; }}
          onPointerCancel={() => { overlayDragRef.current = null; }}
        >
          {project.source.type === "youtube" ? (
            <div
              className="absolute"
              style={{
                width: `${playerWidthPercent}%`,
                height: `${playerHeightPercent}%`,
                left: `${playerLeftPercent}%`,
                top: `${playerTopPercent}%`,
              }}
            >
              <div
                ref={youtubeHostRef}
                className="h-full w-full"
                style={{ pointerEvents: editable ? "none" : "auto" }}
              />
            </div>
          ) : videoUrl ? (
            <video
              ref={videoRef}
              src={videoUrl}
              className="block h-full w-full"
              style={{
                objectFit: position.fit,
                objectPosition: `${position.x}% ${position.y}%`,
                transform: `scale(${position.zoom})`,
                transformOrigin: "center center",
                pointerEvents: editable ? "none" : "auto",
              }}
              playsInline
              preload="metadata"
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
            />
          ) : (
            <div className="flex h-full items-center justify-center p-4 text-center text-sm text-slate-400">
              Choose an authorized MP4 or WebM source to preview reliable manual reframing.
            </div>
          )}
          {project.brollClips.map((clip) => {
            const active = currentTime >= clip.startSeconds && currentTime < clip.endSeconds;
            return (
              <video
                key={clip.id}
                ref={(element) => {
                  if (element) brollVideoRefs.current.set(clip.id, element);
                  else brollVideoRefs.current.delete(clip.id);
                }}
                src={clip.videoUrl}
                muted
                playsInline
                preload="metadata"
                aria-label={`B-roll: ${clip.fileName}`}
                className="absolute inset-0 h-full w-full"
                style={{
                  display: active ? "block" : "none",
                  objectFit: clip.fit,
                  pointerEvents: "none",
                  zIndex: 30,
                }}
                onLoadedMetadata={() => syncAuxiliaryMedia(currentTime, playing)}
              />
            );
          })}
          {project.musicTracks.map((track) => (
            <audio
              key={track.id}
              ref={(element) => {
                if (element) musicTrackRefs.current.set(track.id, element);
                else musicTrackRefs.current.delete(track.id);
              }}
              src={track.audioUrl}
              preload="metadata"
              aria-label={`Instrumental: ${track.fileName}`}
              onLoadedMetadata={() => syncAuxiliaryMedia(currentTime, playing)}
            />
          ))}
          {project.captionsEnabled && activeTimedCaption && (
            <div
              className={`pointer-events-none absolute left-[5%] right-[5%] z-[50] text-center leading-[1.12] ${captionPosition}`}
              aria-live="off"
            >
              <span
                className="inline-block max-w-full px-[0.35em] py-[0.18em] [overflow-wrap:anywhere] [display:-webkit-inline-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] [overflow:hidden]"
                style={{
                  ...captionStyle,
                  color: project.captionTextColor,
                  fontFamily: captionFontFamily,
                  fontSize: `clamp(12px, ${captionFontSize}cqw, 48px)`,
                  WebkitBoxDecorationBreak: "clone",
                }}
              >
                {activeTimedCaption.text}
              </span>
            </div>
          )}
          {activeOverlays.map((overlay) => {
            const positionStyle = {
              left: `${overlay.left}%`,
              top: `${overlay.top}%`,
              width: `${overlay.width}%`,
              height: `${overlay.height}%`,
              opacity: overlay.opacity,
              zIndex: overlay.zIndex,
            };
            if (overlay.type === "text") {
              return (
                <div
                  key={overlay.id}
                  className="pointer-events-none absolute z-10 flex items-center justify-center overflow-hidden text-center leading-tight"
                  style={{
                    ...positionStyle,
                    color: overlay.textColor,
                    backgroundColor: overlay.backgroundColor,
                    fontSize: `${overlay.fontSize}px`,
                    fontWeight: overlay.textStyle === "plain" ? 700 : 800,
                    textTransform: overlay.textStyle === "headline" || overlay.textStyle === "pill" ? "uppercase" : undefined,
                    letterSpacing: overlay.textStyle === "pill" ? "0.12em" : undefined,
                    padding: "0.25rem",
                    borderRadius: `${overlay.borderRadius}px`,
                    border: overlay.borderWidth > 0
                      ? `${overlay.borderWidth}px solid ${overlay.borderColor}`
                      : undefined,
                    textShadow: overlay.backgroundColor === "transparent" ? "0 2px 8px #000" : undefined,
                    boxShadow: overlay.textStyle === "plain" ? undefined : "0 8px 24px rgb(0 0 0 / 35%)",
                  }}
                >
                  {overlay.text}
                </div>
              );
            }
            if (overlay.imageUrl) {
              const canDragImage = editable && !isFullscreen && Boolean(onOverlayChange);
              return (
                <div
                  key={overlay.id}
                  className={`absolute z-10 overflow-hidden ${canDragImage ? "cursor-move touch-none" : "pointer-events-none"}`}
                  style={positionStyle}
                  onPointerDown={canDragImage ? (event) => startOverlayDrag(event, overlay, "move") : undefined}
                  role={canDragImage ? "group" : undefined}
                  aria-label={canDragImage ? "Drag image overlay to reposition" : undefined}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={overlay.imageUrl}
                    alt=""
                    className="h-full w-full"
                    draggable={false}
                    style={{
                      objectFit: overlay.type === "frame" ? "fill" : overlay.imageFit ?? "contain",
                      pointerEvents: "none",
                    }}
                  />
                  {canDragImage && (
                    <button
                      type="button"
                      onPointerDown={(event) => startOverlayDrag(event, overlay, "resize")}
                      aria-label="Drag to resize image overlay"
                      title="Drag to resize"
                      className="absolute bottom-0 right-0 flex min-h-12 min-w-12 items-end justify-end rounded-tl-lg bg-black/70 p-2"
                    >
                      <span className="h-4 w-4 rounded-sm border-b-2 border-r-2 border-white" />
                    </button>
                  )}
                </div>
              );
            }
            const cornerStyle = {
              borderColor: overlay.borderColor,
              borderWidth: `${overlay.borderWidth}px`,
              filter: overlay.frameStyle === "neon" ? `drop-shadow(0 0 8px ${overlay.borderColor})` : undefined,
            };
            return (
              <div
                key={overlay.id}
                className="pointer-events-none absolute box-border"
                style={{
                  ...positionStyle,
                  borderColor: overlay.borderColor,
                  borderWidth: `${overlay.borderWidth}px`,
                  borderStyle: overlay.frameStyle === "corner-brackets" ? "none" : "solid",
                  borderRadius: overlay.frameStyle === "corner-brackets" ? 0 : `${overlay.borderRadius}px`,
                  boxShadow: overlay.frameStyle === "neon"
                    ? `inset 0 0 14px ${overlay.borderColor}, 0 0 12px ${overlay.borderColor}`
                    : overlay.frameStyle === "outline"
                      ? "inset 0 0 18px rgb(0 0 0 / 25%)"
                      : undefined,
                }}
              >
                {overlay.frameStyle === "corner-brackets" && (
                  <>
                    <span className="absolute left-0 top-0 h-1/4 w-1/4 border-l border-t" style={cornerStyle} />
                    <span className="absolute right-0 top-0 h-1/4 w-1/4 border-r border-t" style={cornerStyle} />
                    <span className="absolute bottom-0 left-0 h-1/4 w-1/4 border-b border-l" style={cornerStyle} />
                    <span className="absolute bottom-0 right-0 h-1/4 w-1/4 border-b border-r" style={cornerStyle} />
                  </>
                )}
              </div>
            );
          })}
          {!editable && !hasStarted && project.thumbnailUrl && (
            <button
              type="button"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={togglePlayback}
              disabled={!sourceReady}
              aria-label={`Play ${project.title}`}
              className="absolute inset-0 z-[80] flex items-center justify-center overflow-hidden bg-black disabled:cursor-not-allowed"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={project.thumbnailUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
              <span className="relative flex min-h-12 min-w-12 items-center justify-center rounded-full bg-cyan-500 px-5 text-sm font-bold text-white shadow-lg">
                {project.source.type === "youtube" && !youtubeReady ? "Loading…" : "Play"}
              </span>
            </button>
          )}
          {isFullscreen && !fullscreenControlsVisible && (
            <button
              type="button"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => setFullscreenControlsVisible(true)}
              aria-label="Show clean-view controls"
              className="absolute inset-0 z-[180] bg-transparent"
            />
          )}
          {(!isFullscreen || fullscreenControlsVisible) && (
            <button
              type="button"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                void toggleFullscreen();
              }}
              aria-label={isFullscreen ? "Exit clean view" : editable ? "Open clean recording view" : "Expand video to fullscreen"}
              title={isFullscreen ? "Exit clean view" : editable ? "Clean recording view" : "Expand video"}
              className="absolute right-2 top-2 z-[200] flex min-h-12 min-w-12 items-center justify-center rounded-lg bg-black/75 px-3 text-xs font-semibold text-white"
            >
              {isFullscreen ? "Exit" : editable ? "Clean view" : "Expand"}
            </button>
          )}
          {isFullscreen && fullscreenControlsVisible && (
            <div className="absolute inset-x-0 bottom-0 z-[190] flex items-center gap-3 bg-gradient-to-t from-black/85 to-transparent px-3 pb-[max(env(safe-area-inset-bottom),_1rem)] pt-8">
              <button
                type="button"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={togglePlayback}
                disabled={!sourceReady}
                aria-label={playing ? "Pause preview" : "Play preview"}
                className="min-h-12 min-w-12 rounded-lg bg-black/75 px-3 text-sm font-bold text-white disabled:opacity-40"
              >
                {playing ? "Pause" : "Play"}
              </button>
              <p className="text-xs text-white/80">Controls hide while playing. Tap the video to show them.</p>
            </div>
          )}
          {showErrors && playerError && (!isFullscreen || fullscreenControlsVisible) && (
            <p role="alert" className="absolute inset-x-2 top-14 z-[210] rounded-lg bg-rose-950/90 p-2 text-xs text-rose-100">
              {playerError}
            </p>
          )}
        </div>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={togglePlayback}
          disabled={!sourceReady}
          className="min-h-12 min-w-12 rounded-lg border border-slate-700 px-3 text-sm font-bold text-white disabled:opacity-40"
          aria-label={playing ? "Pause preview" : "Play preview"}
        >
          {playing ? "Pause" : "Play"}
        </button>
        <input
          type="range"
          min={project.startSeconds}
          max={Math.max(project.startSeconds + 0.1, Math.min(project.endSeconds, duration))}
          step="0.1"
          value={Math.min(currentTime, project.endSeconds)}
          onChange={(event) => seek(Number(event.target.value))}
          className="min-h-12 min-w-0 flex-1 accent-cyan-400"
          aria-label="Seek preview"
        />
        <span className="min-w-16 text-right text-xs tabular-nums text-slate-400">{formatTime(currentTime)}</span>
      </div>
      {project.status === "published" && !compactPreview && !embedMode && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => void shareShort()}
            className="min-h-12 rounded-lg border border-slate-700 px-4 text-sm font-semibold text-slate-200"
          >
            Share short
          </button>
          <button
            type="button"
            onClick={() => void copyEmbedLink()}
            className="ml-2 min-h-12 rounded-lg border border-cyan-900 px-4 text-sm font-semibold text-cyan-100"
          >
            Copy player link
          </button>
          {shareStatus && <p role="status" className="mt-2 text-xs text-emerald-300">{shareStatus}</p>}
          {showErrors && shareError && <p role="alert" className="mt-2 text-xs text-rose-300">{shareError}</p>}
        </div>
      )}
      {project.source.type === "youtube" && !compactPreview && !embedMode && (
        <a
          href={`https://www.youtube.com/watch?v=${project.source.videoId}`}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-flex min-h-12 items-center text-xs font-semibold text-cyan-300"
        >
          Watch original on YouTube
        </a>
      )}
      {editable && project.source.type === "youtube" && !compactPreview && (
        <p className="mt-1 text-xs leading-relaxed text-amber-200">
          YouTube crop is best-effort: framing scales and shifts the embedded player. Use an authorized upload for clean, reliable reframing.
        </p>
      )}
      {(project.brollClips.some((clip) => clip.provider === "pexels")
        || project.musicTracks.some((track) => track.provider === "jamendo")) && (
        <div className="mt-2 border-t border-slate-800 pt-2 text-xs leading-relaxed text-slate-400">
          <p className="font-semibold text-slate-300">Media credits</p>
          {project.brollClips.filter((clip) => clip.provider === "pexels").map((clip) => (
            <p key={`credit-${clip.id}`}>
              Video by{" "}
              <a href={clip.creatorUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-12 items-center underline underline-offset-2">
                {clip.creatorName}
              </a>
              {" · "}
              <a href={clip.providerPageUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-12 items-center underline underline-offset-2">
                Pexels source
              </a>
              {" · "}
              <a href={clip.licenseUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-12 items-center underline underline-offset-2">
                {clip.licenseName}
              </a>
            </p>
          ))}
          {project.musicTracks.filter((track) => track.provider === "jamendo").map((track) => (
            <p key={`credit-${track.id}`}>
              Music by{" "}
              <a href={track.creatorUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-12 items-center underline underline-offset-2">
                {track.creatorName}
              </a>
              {" · "}
              <a href={track.providerPageUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-12 items-center underline underline-offset-2">
                Jamendo track
              </a>
              {" · "}
              <a href={track.licenseUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-12 items-center underline underline-offset-2">
                {track.licenseName}
              </a>
              {" · "}
              <a href="https://www.jamendo.com" target="_blank" rel="noreferrer" className="inline-flex min-h-12 items-center underline underline-offset-2">
                Jamendo
              </a>
            </p>
          ))}
        </div>
      )}
    </div>
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
