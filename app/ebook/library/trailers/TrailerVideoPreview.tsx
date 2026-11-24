"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";
import type { TrailerMoment } from "@/lib/schemas/trailer";
import type { TrailerProject } from "@/lib/schemas/trailer";
import { loadYouTubeApi } from "@/lib/youtube-iframe-api";
import type { YouTubePlayerInstance } from "@/lib/youtube-iframe-api";
import { getTrailerFrameAtTime, getTrailerTransitionEffect } from "@/lib/trailer-utils";

type YouTubePlayerStateChange = { data: number };

type Props = {
  project: TrailerProject;
  localVideoUrl: string | null;
  playRequest: { index: number; nonce: number } | null;
  seekRequest: { index: number; timeSeconds: number; nonce: number } | null;
  activeMoment: number;
  onActiveMomentChange: (index: number) => void;
  onCurrentTimeChange: (timeSeconds: number) => void;
  onCropChange: (timeSeconds: number, cropX: number, cropY: number, zoom: number, fit: "cover" | "contain") => void;
  onError: (message: string) => void;
  editable?: boolean;
};

export default function TrailerVideoPreview({
  project,
  localVideoUrl,
  playRequest,
  seekRequest,
  activeMoment,
  onActiveMomentChange,
  onCurrentTimeChange,
  onCropChange,
  onError,
  editable = true,
}: Props) {
  const playerTargetRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YouTubePlayerInstance | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const musicAudioRef = useRef(new Map<string, HTMLAudioElement>());
  const cropDragRef = useRef<{
    x: number;
    y: number;
    timeSeconds: number;
    zoom: number;
    fit: "cover" | "contain";
    clientX: number;
    clientY: number;
    width: number;
    height: number;
  } | null>(null);
  const momentsRef = useRef<TrailerMoment[]>(project.moments);
  const activeMomentRef = useRef(0);
  const lastReportedTimeRef = useRef(-1);
  const [playerReady, setPlayerReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [localVideoReady, setLocalVideoReady] = useState(false);
  const [sourceAspectRatio, setSourceAspectRatio] = useState(16 / 9);
  const [playerError, setPlayerError] = useState("");

  momentsRef.current = project.moments;
  activeMomentRef.current = activeMoment;

  const musicTrackKey = JSON.stringify(project.musicTracks.map((track) => [
    track.id,
    track.audioUrl,
    track.loop,
  ]));
  useEffect(() => {
    const audioElements = new Map<string, HTMLAudioElement>();
    for (const track of project.musicTracks) {
      const audio = document.createElement("audio");
      audio.crossOrigin = "anonymous";
      audio.preload = "auto";
      audio.loop = track.loop;
      audio.src = track.audioUrl;
      audio.load();
      audioElements.set(track.id, audio);
    }
    musicAudioRef.current = audioElements;
    return () => {
      audioElements.forEach((audio) => {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      });
      if (musicAudioRef.current === audioElements) musicAudioRef.current = new Map();
    };
  }, [musicTrackKey]);

  const setMoment = (index: number) => {
    activeMomentRef.current = index;
    onActiveMomentChange(index);
    const moment = momentsRef.current[index];
    if (moment) reportCurrentTime(moment.startSeconds, true);
  };

  const reportCurrentTime = useCallback((timeSeconds: number, force = false) => {
    if (!Number.isFinite(timeSeconds)) return;
    if (!force && Math.abs(timeSeconds - lastReportedTimeRef.current) < 0.05) return;
    lastReportedTimeRef.current = timeSeconds;
    onCurrentTimeChange(timeSeconds);
  }, [onCurrentTimeChange]);

  const syncPreviewMusic = useCallback((
    sourceTimeSeconds: number,
    momentIndex: number,
    shouldPlay: boolean,
  ) => {
    const moment = project.moments[momentIndex];
    if (!moment) return;
    const outputOffset = project.moments.slice(0, momentIndex).reduce(
      (total, item) => total + item.endSeconds - item.startSeconds,
      0,
    );
    const outputTimeSeconds = outputOffset + Math.max(
      0,
      Math.min(moment.endSeconds - moment.startSeconds, sourceTimeSeconds - moment.startSeconds),
    );
    const speechActive = project.transcript.some((segment) =>
      sourceTimeSeconds >= segment.startSeconds && sourceTimeSeconds < segment.endSeconds,
    );
    for (const track of project.musicTracks) {
      const audio = musicAudioRef.current.get(track.id);
      if (!audio) continue;
      const active = outputTimeSeconds >= track.startSeconds && outputTimeSeconds < track.endSeconds;
      if (!active || !shouldPlay) {
        audio.pause();
        continue;
      }
      const elapsed = outputTimeSeconds - track.startSeconds;
      const duration = Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration
        : track.sourceDurationSeconds;
      const target = track.loop ? elapsed % duration : Math.min(elapsed, duration - 0.05);
      if (Math.abs(audio.currentTime - target) > 0.75) audio.currentTime = target;
      const fadeIn = track.fadeInSeconds > 0 ? Math.min(1, elapsed / track.fadeInSeconds) : 1;
      const fadeOut = track.fadeOutSeconds > 0
        ? Math.min(1, (track.endSeconds - outputTimeSeconds) / track.fadeOutSeconds)
        : 1;
      const duck = track.duckUnderSpeech && speechActive ? track.duckVolume : 1;
      audio.volume = Math.max(0, Math.min(1, track.volume * fadeIn * fadeOut * duck));
      if (audio.paused) {
        void audio.play().catch(() => {
          onError("The soundtrack preview was blocked. Tap Play trailer again to start audio.");
        });
      }
    }
  }, [onError, project]);

  useEffect(() => {
    if (!project.source.videoId || localVideoUrl || !playerTargetRef.current) return;
    let active = true;
    setPlayerReady(false);
    setPlayerError("");

    loadYouTubeApi().then((api) => {
      if (!active || !playerTargetRef.current) return;
      playerRef.current = new api.Player(playerTargetRef.current, {
        width: "100%",
        height: "100%",
        videoId: project.source.videoId!,
        playerVars: {
          autoplay: 0,
          cc_load_policy: 0,
          controls: 0,
          disablekb: 1,
          enablejsapi: 1,
          fs: 0,
          iv_load_policy: 3,
          playsinline: 1,
          rel: 0,
          origin: window.location.origin,
        },
        events: {
          onReady: () => {
            if (!active || !playerRef.current) return;
            const iframe = playerRef.current.getIframe();
            iframe.title = project.source.videoTitle || "Trailer source video";
            iframe.referrerPolicy = "strict-origin-when-cross-origin";
            iframe.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
            iframe.allowFullscreen = true;
            iframe.style.pointerEvents = "none";
            playerRef.current.unloadModule("captions");
            setPlayerReady(true);
          },
          onStateChange: (event: YouTubePlayerStateChange) => {
            const isPlaying = event.data === 1;
            setPlaying(isPlaying);
            const player = playerRef.current;
            player?.unloadModule("captions");
            if (isPlaying) {
              const timeSeconds = player?.getCurrentTime();
              if (timeSeconds !== undefined) reportCurrentTime(timeSeconds, true);
            }
          },
          onError: (event: YouTubePlayerStateChange) => {
            const message = `YouTube could not play this embedded video (player error ${event.data}).`;
            setPlayerError(message);
            onError(message);
          },
        },
      });
    }).catch((error: unknown) => {
      if (!active) return;
      const message = error instanceof Error ? error.message : "Could not load the YouTube player.";
      setPlayerError(message);
      onError(message);
    });

    return () => {
      active = false;
      playerRef.current?.destroy();
      playerRef.current = null;
      setPlayerReady(false);
      setPlaying(false);
    };
  }, [localVideoUrl, onError, project.source.videoId, project.source.videoTitle, reportCurrentTime]);

  useEffect(() => {
    if (!playRequest || playRequest.nonce === 0) return;
    const moment = momentsRef.current[playRequest.index];
    if (!moment) return;
    setMoment(playRequest.index);
    if (localVideoUrl) {
      if (!localVideoReady) return;
      const video = localVideoRef.current;
      if (!video) {
        onError("Upload or re-select the source video to preview this trailer.");
        return;
      }
      video.currentTime = moment.startSeconds;
      syncPreviewMusic(moment.startSeconds, playRequest.index, true);
      void video.play().catch((error: unknown) => {
        onError(error instanceof Error ? error.message : "The uploaded source could not play.");
      });
      return;
    }
    if (project.source.videoId) {
      const player = playerRef.current;
      if (!player || !playerReady) {
        setPlayerError("Wait for the embedded YouTube player to finish loading.");
        return;
      }
      player.seekTo(moment.startSeconds, true);
      syncPreviewMusic(moment.startSeconds, playRequest.index, true);
      player.playVideo();
      return;
    }
    if (!localVideoReady) return;
    const video = localVideoRef.current;
    if (!video) {
      onError("Upload or re-select the source video to preview this trailer.");
      return;
    }
    video.currentTime = moment.startSeconds;
    syncPreviewMusic(moment.startSeconds, playRequest.index, true);
    void video.play().catch((error: unknown) => {
      onError(error instanceof Error ? error.message : "The uploaded source could not play.");
    });
  }, [localVideoReady, localVideoUrl, onError, playRequest, playerReady, project.source.videoId, syncPreviewMusic]);

  useEffect(() => {
    if (!seekRequest || seekRequest.nonce === 0) return;
    const moment = momentsRef.current[seekRequest.index];
    if (!moment) return;
    setMoment(seekRequest.index);
    const timeSeconds = Math.max(
      moment.startSeconds,
      Math.min(moment.endSeconds, seekRequest.timeSeconds),
    );
    if (localVideoUrl) {
      if (!localVideoReady) return;
      const video = localVideoRef.current;
      if (!video) {
        onError("Upload or re-select the source video to preview this trailer.");
        return;
      }
      video.currentTime = timeSeconds;
      reportCurrentTime(timeSeconds, true);
      return;
    }
    if (project.source.videoId) {
      const player = playerRef.current;
      if (!player || !playerReady) return;
      player.seekTo(timeSeconds, true);
      reportCurrentTime(timeSeconds, true);
      return;
    }
    if (!localVideoReady) return;
    const video = localVideoRef.current;
    if (!video) return;
    video.currentTime = timeSeconds;
    reportCurrentTime(timeSeconds, true);
  }, [
    localVideoReady,
    localVideoUrl,
    onError,
    playerReady,
    project.source.videoId,
    reportCurrentTime,
    seekRequest,
  ]);

  useEffect(() => {
    if (!project.source.videoId || localVideoUrl || !playing) return;
    const interval = window.setInterval(() => {
      const player = playerRef.current;
      const moment = momentsRef.current[activeMomentRef.current];
      if (!player || !moment) return;
      const currentTime = player.getCurrentTime();
      reportCurrentTime(currentTime);
      syncPreviewMusic(currentTime, activeMomentRef.current, true);
      if (currentTime < moment.endSeconds - 0.12) return;

      const nextIndex = activeMomentRef.current + 1;
      if (nextIndex >= momentsRef.current.length) {
        player.pauseVideo();
        return;
      }
      setMoment(nextIndex);
      player.seekTo(momentsRef.current[nextIndex].startSeconds, true);
    }, 33);
    return () => window.clearInterval(interval);
  }, [localVideoUrl, onActiveMomentChange, playing, project.source.videoId, reportCurrentTime, syncPreviewMusic]);

  useEffect(() => {
    if (!localVideoUrl || !playing) return;
    const interval = window.setInterval(() => {
      const currentTime = localVideoRef.current?.currentTime;
      if (currentTime !== undefined) {
        reportCurrentTime(currentTime);
        syncPreviewMusic(currentTime, activeMomentRef.current, true);
      }
    }, 33);
    return () => window.clearInterval(interval);
  }, [localVideoUrl, playing, reportCurrentTime, syncPreviewMusic]);

  useEffect(() => {
    if (playing) return;
    musicAudioRef.current.forEach((audio) => audio.pause());
  }, [playing]);

  function handleLocalTimeUpdate() {
    const video = localVideoRef.current;
    const moment = momentsRef.current[activeMomentRef.current];
    if (video) reportCurrentTime(video.currentTime);
    if (!video || !moment || video.paused || video.seeking || video.currentTime < moment.endSeconds - 0.08) return;
    const nextIndex = activeMomentRef.current + 1;
    if (nextIndex >= momentsRef.current.length) {
      video.pause();
      setPlaying(false);
      return;
    }
    setMoment(nextIndex);
    video.currentTime = momentsRef.current[nextIndex].startSeconds;
  }

  const currentTime = localVideoRef.current?.currentTime
    ?? playerRef.current?.getCurrentTime()
    ?? project.moments[activeMoment]?.startSeconds
    ?? 0;
  const frameAtTime = getTrailerFrameAtTime(project, activeMoment, currentTime);
  const slot = frameAtTime?.slot;
  const frame = frameAtTime?.position ?? { x: 50, y: 50, zoom: 1, fit: project.fit };
  const aspectRatio = slot?.aspectRatio ?? project.aspectRatio;
  const [ratioWidth, ratioHeight] = aspectRatio.split(":").map(Number);
  const ratio = ratioWidth / ratioHeight;
  const sourceRatio = localVideoUrl ? sourceAspectRatio : 16 / 9;
  const widthAtFit = frame.fit === "cover"
    ? Math.max(100, sourceRatio / ratio * 100)
    : Math.min(100, sourceRatio / ratio * 100);
  const heightAtFit = frame.fit === "cover"
    ? Math.max(100, ratio / sourceRatio * 100)
    : Math.min(100, ratio / sourceRatio * 100);
  const widthPercent = widthAtFit * frame.zoom;
  const heightPercent = heightAtFit * frame.zoom;
  const playerStyle = {
    position: "absolute" as const,
    width: `${widthPercent}%`,
    height: `${heightPercent}%`,
    maxWidth: "none",
    left: `${(100 - widthPercent) * frame.x / 100}%`,
    top: `${(100 - heightPercent) * frame.y / 100}%`,
    border: 0,
    pointerEvents: "none" as const,
  };
  const transitionEffect = project.moments[activeMoment]
    ? getTrailerTransitionEffect(project.moments[activeMoment], currentTime)
    : { opacity: 1, translateX: 0, translateY: 0, scale: 1 };
  const transitionStyle = {
    opacity: transitionEffect.opacity,
    transform: `translate(${transitionEffect.translateX * 100}%, ${transitionEffect.translateY * 100}%) scale(${transitionEffect.scale})`,
  };

  useEffect(() => {
    if (!playerReady || !project.source.videoId || localVideoUrl) return;
    const iframe = playerRef.current?.getIframe();
    if (iframe) Object.assign(iframe.style, playerStyle);
  }, [localVideoUrl, playerReady, project.source.videoId, playerStyle.height, playerStyle.left, playerStyle.top, playerStyle.width]);

  useEffect(() => {
    setLocalVideoReady(false);
    setSourceAspectRatio(16 / 9);
  }, [localVideoUrl]);

  function startCropDrag(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    cropDragRef.current = {
      x: frame.x,
      y: frame.y,
      timeSeconds: localVideoRef.current?.currentTime
        ?? playerRef.current?.getCurrentTime()
        ?? currentTime,
      zoom: frame.zoom,
      fit: frame.fit,
      clientX: event.clientX,
      clientY: event.clientY,
      width: bounds.width,
      height: bounds.height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveCropDrag(event: PointerEvent<HTMLDivElement>) {
    const drag = cropDragRef.current;
    if (!drag) return;
    onCropChange(
      drag.timeSeconds,
      Math.max(0, Math.min(100, drag.x - (event.clientX - drag.clientX) / drag.width * 100)),
      Math.max(0, Math.min(100, drag.y - (event.clientY - drag.clientY) / drag.height * 100)),
      drag.zoom,
      drag.fit,
    );
  }

  return (
    <div className="space-y-3">
      <div
        className={`relative mx-auto w-full max-w-xl overflow-hidden rounded-xl border border-slate-700 bg-black ${editable ? "touch-none" : ""}`}
        style={{ aspectRatio: aspectRatio.replace(":", "/") }}
        onPointerDown={editable ? startCropDrag : undefined}
        onPointerMove={editable ? moveCropDrag : undefined}
        onPointerUp={editable ? () => { cropDragRef.current = null; } : undefined}
        onPointerCancel={editable ? () => { cropDragRef.current = null; } : undefined}
        aria-label={editable ? "Drag the video to adjust its crop" : undefined}
      >
        <div className="absolute inset-0 overflow-hidden" style={transitionStyle}>
          {localVideoUrl ? (
            <video
              ref={localVideoRef}
              src={localVideoUrl}
              playsInline
              onLoadedMetadata={() => {
                const video = localVideoRef.current;
                if (video && video.videoHeight > 0) {
                  setSourceAspectRatio(video.videoWidth / video.videoHeight);
                }
                setLocalVideoReady(true);
                reportCurrentTime(video?.currentTime ?? 0, true);
              }}
              onError={() => onError("The uploaded source could not be decoded for preview. Re-select the source file and try again.")}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onTimeUpdate={handleLocalTimeUpdate}
              className="pointer-events-none"
              style={playerStyle}
            />
          ) : project.source.videoId ? (
            <div ref={playerTargetRef} style={playerStyle} />
          ) : (
            <div className="flex h-full items-center justify-center p-6 text-center text-sm text-slate-400">
              Upload or re-select a source file to preview it here.
            </div>
          )}
        </div>
        <div className="pointer-events-none absolute inset-0" style={transitionStyle}>
          {project.brandLine && (
            <p className="pointer-events-none absolute left-3 right-3 top-3 z-10 text-center text-xs font-bold uppercase tracking-widest text-cyan-200 drop-shadow-[0_2px_4px_rgba(0,0,0,0.95)] sm:text-sm">
              {project.brandLine}
            </p>
          )}
          {project.headline && (
            <p className="pointer-events-none absolute left-4 right-4 top-[18%] z-10 text-center text-lg font-black text-white drop-shadow-[0_2px_5px_rgba(0,0,0,0.95)] sm:text-2xl">
              {project.headline}
            </p>
          )}
          {project.moments[activeMoment]?.title && (
            <p className={`pointer-events-none absolute left-4 right-4 z-10 text-center text-base font-bold text-white drop-shadow-[0_2px_5px_rgba(0,0,0,0.95)] sm:text-xl ${project.callToAction ? "bottom-[28%]" : "bottom-[18%]"}`}>
              {project.moments[activeMoment].title}
            </p>
          )}
          {project.moments[activeMoment]?.hook && (
            <p className={`pointer-events-none absolute left-4 right-4 z-10 max-h-24 overflow-hidden text-center text-sm font-medium text-white drop-shadow-[0_2px_5px_rgba(0,0,0,0.95)] sm:text-base ${project.callToAction ? "bottom-[17%]" : "bottom-[8%]"}`}>
              {project.moments[activeMoment].hook}
            </p>
          )}
          {project.callToAction && activeMoment === project.moments.length - 1 && (
            <p className="pointer-events-none absolute bottom-3 left-1/2 z-10 max-w-[88%] -translate-x-1/2 rounded-full bg-cyan-300 px-4 py-2 text-center text-xs font-extrabold text-slate-950 sm:text-sm">
              {project.callToAction}
            </p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => {
            if (localVideoUrl) {
              const video = localVideoRef.current;
              if (!video || !localVideoReady || momentsRef.current.length === 0) return;
              setMoment(0);
              const startSeconds = momentsRef.current[0].startSeconds;
              video.currentTime = startSeconds;
              syncPreviewMusic(startSeconds, 0, true);
              void video.play().catch((error: unknown) => {
                onError(error instanceof Error ? error.message : "The uploaded source could not play.");
              });
              return;
            }
            if (project.source.videoId) {
              const player = playerRef.current;
              if (!player || !playerReady) {
                setPlayerError("Wait for the embedded YouTube player to finish loading.");
                return;
              }
              setMoment(0);
              const startSeconds = momentsRef.current[0]?.startSeconds ?? 0;
              player.seekTo(startSeconds, true);
              syncPreviewMusic(startSeconds, 0, true);
              player.playVideo();
              return;
            }
            const video = localVideoRef.current;
            if (!video || momentsRef.current.length === 0) return;
            setMoment(0);
            const startSeconds = momentsRef.current[0].startSeconds;
            video.currentTime = startSeconds;
            syncPreviewMusic(startSeconds, 0, true);
            void video.play().catch((error: unknown) => {
              onError(error instanceof Error ? error.message : "The uploaded source could not play.");
            });
          }}
          disabled={project.moments.length === 0 || (
            localVideoUrl ? !localVideoReady : project.source.videoId ? !playerReady : true
          )}
          className="min-h-12 rounded-lg bg-cyan-300 px-4 text-sm font-bold text-slate-950 disabled:opacity-50"
        >
          Play trailer
        </button>
        <button
          type="button"
          onClick={() => {
            playerRef.current?.pauseVideo();
            localVideoRef.current?.pause();
          }}
          disabled={!playing}
          className="min-h-12 rounded-lg border border-slate-700 px-4 text-sm font-semibold text-slate-200 disabled:opacity-50"
        >
          Pause
        </button>
        <span role="status" className="text-xs text-slate-400">
          {playerError || (localVideoReady || playerReady ? `Moment ${activeMoment + 1} of ${project.moments.length}` : "Loading video…")}
        </span>
      </div>
    </div>
  );
}
