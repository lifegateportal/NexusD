"use client";

import { useEffect, useRef, useState } from "react";
import type { TrailerMoment } from "@/lib/schemas/trailer";
import type { TrailerProject } from "@/lib/schemas/trailer";
import { loadYouTubeApi } from "@/lib/youtube-iframe-api";
import type { YouTubePlayerInstance } from "@/lib/youtube-iframe-api";

type YouTubePlayerStateChange = { data: number };

type Props = {
  project: TrailerProject;
  localVideoUrl: string | null;
  playRequest: { index: number; nonce: number } | null;
  activeMoment: number;
  onActiveMomentChange: (index: number) => void;
  onError: (message: string) => void;
};

export default function TrailerVideoPreview({
  project,
  localVideoUrl,
  playRequest,
  activeMoment,
  onActiveMomentChange,
  onError,
}: Props) {
  const playerTargetRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YouTubePlayerInstance | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const momentsRef = useRef<TrailerMoment[]>(project.moments);
  const activeMomentRef = useRef(0);
  const [playerReady, setPlayerReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [localVideoReady, setLocalVideoReady] = useState(false);
  const [playerError, setPlayerError] = useState("");

  momentsRef.current = project.moments;
  activeMomentRef.current = activeMoment;

  const setMoment = (index: number) => {
    activeMomentRef.current = index;
    onActiveMomentChange(index);
  };

  useEffect(() => {
    if (!project.source.videoId || !playerTargetRef.current) return;
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
          controls: 1,
          enablejsapi: 1,
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
            setPlayerReady(true);
          },
          onStateChange: (event: YouTubePlayerStateChange) => setPlaying(event.data === 1),
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
  }, [onError, project.source.videoId, project.source.videoTitle]);

  useEffect(() => {
    if (!playRequest || playRequest.nonce === 0) return;
    const moment = momentsRef.current[playRequest.index];
    if (!moment) return;
    setMoment(playRequest.index);
    if (project.source.videoId) {
      const player = playerRef.current;
      if (!player || !playerReady) {
        setPlayerError("Wait for the embedded YouTube player to finish loading.");
        return;
      }
      player.seekTo(moment.startSeconds, true);
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
    void video.play().catch((error: unknown) => {
      onError(error instanceof Error ? error.message : "The uploaded source could not play.");
    });
  }, [localVideoReady, onError, playRequest, playerReady, project.source.videoId]);

  useEffect(() => {
    if (!project.source.videoId || !playing) return;
    const interval = window.setInterval(() => {
      const player = playerRef.current;
      const moment = momentsRef.current[activeMomentRef.current];
      if (!player || !moment) return;
      if (player.getCurrentTime() < moment.endSeconds - 0.12) return;

      const nextIndex = activeMomentRef.current + 1;
      if (nextIndex >= momentsRef.current.length) {
        player.pauseVideo();
        return;
      }
      setMoment(nextIndex);
      player.seekTo(momentsRef.current[nextIndex].startSeconds, true);
    }, 100);
    return () => window.clearInterval(interval);
  }, [onActiveMomentChange, playing, project.source.videoId]);

  function handleLocalTimeUpdate() {
    const video = localVideoRef.current;
    const moment = momentsRef.current[activeMomentRef.current];
    if (!video || !moment || video.paused || video.currentTime < moment.endSeconds - 0.08) return;
    const nextIndex = activeMomentRef.current + 1;
    if (nextIndex >= momentsRef.current.length) {
      video.pause();
      setPlaying(false);
      return;
    }
    setMoment(nextIndex);
    video.currentTime = momentsRef.current[nextIndex].startSeconds;
  }

  const [ratioWidth, ratioHeight] = project.aspectRatio.split(":").map(Number);
  const ratio = ratioWidth / ratioHeight;
  const sourceRatio = 16 / 9;
  let widthPercent = 100;
  let heightPercent = 100;
  if (project.fit === "cover") {
    if (ratio < sourceRatio) widthPercent = sourceRatio / ratio * 100;
    else heightPercent = ratio / sourceRatio * 100;
  } else if (ratio < sourceRatio) {
    heightPercent = ratio / sourceRatio * 100;
  } else {
    widthPercent = sourceRatio / ratio * 100;
  }
  widthPercent *= project.zoom;
  heightPercent *= project.zoom;
  const playerStyle = {
    position: "absolute" as const,
    width: `${widthPercent}%`,
    height: `${heightPercent}%`,
    maxWidth: "none",
    left: `${(100 - widthPercent) * project.cropX / 100}%`,
    top: `${(100 - heightPercent) * project.cropY / 100}%`,
    border: 0,
  };

  useEffect(() => {
    if (!playerReady || !project.source.videoId) return;
    const iframe = playerRef.current?.getIframe();
    if (iframe) Object.assign(iframe.style, playerStyle);
  }, [playerReady, project.source.videoId, playerStyle.height, playerStyle.left, playerStyle.top, playerStyle.width]);

  useEffect(() => {
    setLocalVideoReady(false);
  }, [localVideoUrl]);

  return (
    <div className="space-y-3">
      <div
        className="relative mx-auto w-full max-w-xl overflow-hidden rounded-xl border border-slate-700 bg-black"
        style={{ aspectRatio: project.aspectRatio.replace(":", "/") }}
      >
        {project.source.videoId ? (
          <div className="absolute inset-0 overflow-hidden">
            <div ref={playerTargetRef} style={playerStyle} />
          </div>
        ) : localVideoUrl ? (
          <video
            ref={localVideoRef}
            src={localVideoUrl}
            controls
            playsInline
            onLoadedMetadata={() => setLocalVideoReady(true)}
            onError={() => onError("The uploaded source could not be decoded for preview. Re-select the source file and try again.")}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onTimeUpdate={handleLocalTimeUpdate}
            className="absolute inset-0 h-full w-full"
            style={{
              objectFit: project.fit,
              objectPosition: `${project.cropX}% ${project.cropY}%`,
              transform: `scale(${project.zoom})`,
            }}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-slate-400">
            Upload or re-select a source file to preview it here.
          </div>
        )}
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
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => {
            if (project.source.videoId) {
              const player = playerRef.current;
              if (!player || !playerReady) {
                setPlayerError("Wait for the embedded YouTube player to finish loading.");
                return;
              }
              setMoment(0);
              player.seekTo(momentsRef.current[0]?.startSeconds ?? 0, true);
              player.playVideo();
              return;
            }
            const video = localVideoRef.current;
            if (!video || momentsRef.current.length === 0) return;
            setMoment(0);
            video.currentTime = momentsRef.current[0].startSeconds;
            void video.play().catch((error: unknown) => {
              onError(error instanceof Error ? error.message : "The uploaded source could not play.");
            });
          }}
          disabled={project.moments.length === 0 || (
            project.source.videoId ? !playerReady : !localVideoReady
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
          {playerError || (playerReady || localVideoUrl ? `Moment ${activeMoment + 1} of ${project.moments.length}` : "Loading embedded player…")}
        </span>
      </div>
    </div>
  );
}
