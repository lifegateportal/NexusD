"use client";

import { useEffect, useRef, useState } from "react";
import { loadYouTubeApi } from "@/lib/youtube-iframe-api";
import type { YouTubePlayerInstance } from "@/lib/youtube-iframe-api";

type Props = {
  videoId: string;
  title: string;
  startSeconds?: number;
  endSeconds?: number;
  initialTimeSeconds?: number;
  editing?: boolean;
  onSetStart?: (seconds: number) => void;
  onSetEnd?: (seconds: number) => void;
  onClose?: () => void;
};

type ViewportBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export default function LibraryYouTubePlayer({
  videoId,
  title,
  startSeconds = 0,
  endSeconds = 0,
  initialTimeSeconds,
  editing = false,
  onSetStart,
  onSetEnd,
  onClose,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const playerFrameRef = useRef<HTMLDivElement>(null);
  const playerHostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YouTubePlayerInstance | null>(null);
  const boundsRef = useRef({ startSeconds, endSeconds, initialTimeSeconds, editing });
  const seekingRef = useRef(false);
  const controlsTimeoutRef = useRef<number | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(startSeconds);
  const [duration, setDuration] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [error, setError] = useState("");
  const [viewportBounds, setViewportBounds] = useState<ViewportBounds | null>(null);

  boundsRef.current = { startSeconds, endSeconds, initialTimeSeconds, editing };

  const timelineStart = editing ? 0 : startSeconds;
  const timelineEnd = editing ? duration || endSeconds : endSeconds;
  const seekEnd = Math.max(timelineStart + 0.1, timelineEnd);
  const fullscreenWidth = viewportBounds
    ? Math.min(viewportBounds.width, viewportBounds.height * 16 / 9)
    : 0;
  const fullscreenHeight = viewportBounds
    ? Math.min(viewportBounds.height, viewportBounds.width * 9 / 16)
    : 0;

  useEffect(() => {
    setReady(false);
    setPlaying(false);
    setError("");
    setCurrentTime(boundsRef.current.initialTimeSeconds ?? boundsRef.current.startSeconds);

    let disposed = false;
    let timer: number | undefined;
    loadYouTubeApi().then((api) => {
      if (disposed || !playerHostRef.current) return;
      const initialTime = boundsRef.current.initialTimeSeconds
        ?? boundsRef.current.startSeconds;
      playerRef.current = new api.Player(playerHostRef.current, {
        width: "100%",
        height: "100%",
        videoId,
        playerVars: {
          autoplay: 0,
          cc_load_policy: 0,
          controls: 0,
          disablekb: 1,
          enablejsapi: 1,
          fs: 0,
          playsinline: 1,
          rel: 0,
          ...(initialTime > 0 ? { start: Math.floor(initialTime) } : {}),
          origin: window.location.origin,
        },
        events: {
          onReady: () => {
            if (disposed) return;
            const player = playerRef.current;
            if (!player) return;
            const iframe = player.getIframe();
            iframe.style.position = "absolute";
            iframe.style.inset = "0";
            iframe.style.width = "100%";
            iframe.style.height = "100%";
            iframe.style.maxWidth = "none";
            iframe.style.border = "0";
            player.unloadModule("captions");
            const initialDuration = player.getDuration();
            if (Number.isFinite(initialDuration) && initialDuration > 0) setDuration(initialDuration);
            player.seekTo(initialTime, true);
            setCurrentTime(initialTime);
            setReady(true);
            timer = window.setInterval(() => {
              const activePlayer = playerRef.current;
              if (!activePlayer) return;
              const time = activePlayer.getCurrentTime();
              const videoDuration = activePlayer.getDuration();
              if (Number.isFinite(videoDuration) && videoDuration > 0) setDuration(videoDuration);
              if (!Number.isFinite(time)) return;
              if (!seekingRef.current) setCurrentTime(time);
              const bounds = boundsRef.current;
              if (!bounds.editing && time >= bounds.endSeconds) {
                if (activePlayer.getPlayerState() === api.PlayerState.PLAYING) {
                  activePlayer.pauseVideo();
                }
                setCurrentTime(bounds.endSeconds);
                setPlaying(false);
              } else {
                setPlaying(activePlayer.getPlayerState() === api.PlayerState.PLAYING);
              }
            }, 200);
          },
          onApiChange: () => playerRef.current?.unloadModule("captions"),
          onStateChange: () => {
            playerRef.current?.unloadModule("captions");
            setPlaying(playerRef.current?.getPlayerState() === api.PlayerState.PLAYING);
          },
          onError: (event: { data: number }) => {
            setError(`YouTube could not play this video in an embedded player (error ${event.data}).`);
          },
        },
      });
    }).catch((loadError: unknown) => {
      if (!disposed) setError(loadError instanceof Error ? loadError.message : "Could not load the YouTube player.");
    });

    return () => {
      disposed = true;
      if (timer !== undefined) window.clearInterval(timer);
      playerRef.current?.destroy();
      playerRef.current = null;
    };
  }, [videoId]);

  useEffect(() => {
    const updateFullscreen = () => {
      setIsFullscreen(document.fullscreenElement === containerRef.current);
    };
    document.addEventListener("fullscreenchange", updateFullscreen);
    return () => document.removeEventListener("fullscreenchange", updateFullscreen);
  }, []);

  useEffect(() => {
    const updateViewport = () => {
      const viewport = window.visualViewport;
      const nextBounds = {
        left: viewport?.offsetLeft ?? 0,
        top: viewport?.offsetTop ?? 0,
        width: viewport?.width ?? window.innerWidth,
        height: viewport?.height ?? window.innerHeight,
      };
      setViewportBounds((current) =>
        current
        && current.left === nextBounds.left
        && current.top === nextBounds.top
        && current.width === nextBounds.width
        && current.height === nextBounds.height
          ? current
          : nextBounds,
      );
    };
    updateViewport();
    window.addEventListener("resize", updateViewport);
    window.visualViewport?.addEventListener("resize", updateViewport);
    window.visualViewport?.addEventListener("scroll", updateViewport);
    return () => {
      window.removeEventListener("resize", updateViewport);
      window.visualViewport?.removeEventListener("resize", updateViewport);
      window.visualViewport?.removeEventListener("scroll", updateViewport);
    };
  }, []);

  useEffect(() => {
    const frame = playerFrameRef.current;
    if (!ready || !frame || !playerRef.current) return;

    const resizePlayer = () => {
      const width = Math.round(frame.clientWidth);
      const height = Math.round(frame.clientHeight);
      if (width > 0 && height > 0) playerRef.current?.setSize(width, height);
    };
    const observer = new ResizeObserver(resizePlayer);
    observer.observe(frame);
    window.addEventListener("resize", resizePlayer);
    window.visualViewport?.addEventListener("resize", resizePlayer);
    resizePlayer();

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resizePlayer);
      window.visualViewport?.removeEventListener("resize", resizePlayer);
    };
  }, [ready]);

  useEffect(() => {
    if (controlsTimeoutRef.current !== undefined) {
      window.clearTimeout(controlsTimeoutRef.current);
      controlsTimeoutRef.current = undefined;
    }
    setControlsVisible(true);
    if (!isFullscreen || !playing) return;
    controlsTimeoutRef.current = window.setTimeout(() => setControlsVisible(false), 2500);
    return () => {
      if (controlsTimeoutRef.current !== undefined) {
        window.clearTimeout(controlsTimeoutRef.current);
        controlsTimeoutRef.current = undefined;
      }
    };
  }, [isFullscreen, playing]);

  function revealControls() {
    setControlsVisible(true);
    if (controlsTimeoutRef.current !== undefined) {
      window.clearTimeout(controlsTimeoutRef.current);
      controlsTimeoutRef.current = undefined;
    }
    if (isFullscreen && playing) {
      controlsTimeoutRef.current = window.setTimeout(() => setControlsVisible(false), 2500);
    }
  }

  function seek(seconds: number) {
    const bounded = Math.max(timelineStart, Math.min(seekEnd, seconds));
    setCurrentTime(bounded);
    playerRef.current?.seekTo(bounded, true);
  }

  function togglePlayback() {
    const player = playerRef.current;
    if (!player || !ready) return;
    if (playing) {
      player.pauseVideo();
      setPlaying(false);
      return;
    }
    if (currentTime >= seekEnd) {
      seek(timelineStart);
    }
    player.playVideo();
    setPlaying(true);
  }

  async function toggleFullscreen() {
    const container = containerRef.current;
    if (isFullscreen) {
      if (document.fullscreenElement === container) {
        try {
          await document.exitFullscreen();
        } catch (fullscreenError) {
          setError(fullscreenError instanceof Error ? fullscreenError.message : "Could not exit fullscreen.");
        }
      } else {
        setIsFullscreen(false);
      }
      return;
    }
    if (container?.requestFullscreen) {
      try {
        await container.requestFullscreen();
        return;
      } catch {
        setError("");
      }
    }
    setIsFullscreen(true);
  }

  const controlsHidden = isFullscreen && !controlsVisible;

  return (
    <div
      ref={containerRef}
      className={isFullscreen
        ? "fixed inset-0 z-[100] h-dvh w-full overflow-hidden bg-black"
        : "w-full"}
      style={isFullscreen && viewportBounds
        ? {
          left: `${viewportBounds.left}px`,
          top: `${viewportBounds.top}px`,
          right: "auto",
          bottom: "auto",
          width: `${viewportBounds.width}px`,
          height: `${viewportBounds.height}px`,
        }
        : undefined}
      onPointerDown={revealControls}
      onPointerMove={revealControls}
    >
      <div
        ref={playerFrameRef}
        className={isFullscreen
          ? "absolute overflow-hidden bg-black"
          : "relative mx-auto aspect-video w-full overflow-hidden bg-black"}
        style={isFullscreen
          ? {
            left: "50%",
            top: "50%",
            width: `${fullscreenWidth}px`,
            height: `${fullscreenHeight}px`,
            aspectRatio: "16 / 9",
            transform: "translate(-50%, -50%)",
          }
          : undefined}
      >
        <div ref={playerHostRef} className="absolute inset-0 h-full w-full" />
        {!ready && !error && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70 text-sm text-white">
            Loading video…
          </div>
        )}
        {error && (
          <p role="alert" className="absolute inset-x-2 top-2 rounded-lg bg-rose-950/90 p-3 text-xs text-rose-100">
            {error}
          </p>
        )}
        <div className="absolute right-2 top-2 flex gap-2">
          <button
            type="button"
            onClick={() => void toggleFullscreen()}
            disabled={!ready}
            aria-label={isFullscreen ? "Exit fullscreen" : "Expand video"}
            className={`flex min-h-12 min-w-12 items-center justify-center rounded-lg bg-black/80 px-3 text-xs font-semibold text-white transition-opacity duration-300 disabled:opacity-40 ${controlsHidden ? "pointer-events-none opacity-0" : "opacity-100"}`}
          >
            {isFullscreen ? "Exit" : "Expand"}
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label={`Close ${title}`}
              className={`flex min-h-12 min-w-12 items-center justify-center rounded-lg bg-black/80 px-3 text-xs font-semibold text-white transition-opacity duration-300 ${controlsHidden ? "pointer-events-none opacity-0" : "opacity-100"}`}
            >
              Close
            </button>
          )}
        </div>
        {controlsHidden && (
          <button
            type="button"
            onClick={revealControls}
            aria-label="Show video controls"
            className="absolute inset-0 z-10 bg-transparent"
          />
        )}
      </div>
      <div className={controlsHidden
        ? "hidden"
        : isFullscreen
        ? "absolute bottom-0 left-1/2 z-[102] flex w-full max-w-none -translate-x-1/2 items-center gap-2 bg-gradient-to-t from-black/95 via-black/75 to-transparent px-3 pb-[max(env(safe-area-inset-bottom),_1rem)] pt-6 lg:px-6 lg:pb-4"
        : "mx-auto mt-2 flex w-full max-w-5xl items-center gap-2"}
        style={isFullscreen ? { width: `${fullscreenWidth}px` } : undefined}
      >
        <button
          type="button"
          onClick={togglePlayback}
          disabled={!ready}
          aria-label={playing ? `Pause ${title}` : `Play ${title}`}
          className="flex min-h-12 min-w-12 items-center justify-center rounded-lg border border-slate-700 px-3 text-sm font-bold text-white disabled:opacity-40"
        >
          {playing ? "Pause" : "Play"}
        </button>
        <input
          type="range"
          min={timelineStart}
          max={seekEnd}
          step="0.1"
          value={Math.max(timelineStart, Math.min(seekEnd, currentTime))}
          onChange={(event) => seek(Number(event.target.value))}
          onPointerDown={() => { seekingRef.current = true; }}
          onPointerUp={() => { seekingRef.current = false; }}
          onPointerCancel={() => { seekingRef.current = false; }}
          onKeyDown={() => { seekingRef.current = true; }}
          onKeyUp={() => { seekingRef.current = false; }}
          onBlur={() => { seekingRef.current = false; }}
          disabled={!ready}
          className="min-h-12 min-w-0 flex-1 accent-cyan-400 disabled:opacity-40"
          aria-label={`Seek ${title}`}
        />
        <span className="min-w-[5.5rem] text-right text-xs tabular-nums text-slate-300">
          {formatTime(Math.max(0, currentTime - timelineStart))} / {formatTime(Math.max(0, timelineEnd - timelineStart))}
        </span>
      </div>
      {editing && (onSetStart || onSetEnd) && (
        <div
          className={`mx-auto mt-2 flex w-full max-w-5xl flex-wrap gap-2 ${
            isFullscreen ? "absolute left-1/2 z-[101] w-full max-w-none -translate-x-1/2 px-3 lg:px-6" : ""
          }`}
          style={isFullscreen
            ? {
              width: `${fullscreenWidth}px`,
              bottom: "calc(4.5rem + env(safe-area-inset-bottom))",
            }
            : undefined}
        >
          {onSetStart && (
            <button
              type="button"
              onClick={() => onSetStart(currentTime)}
              disabled={!ready}
              className="min-h-12 rounded-lg border border-amber-800 px-4 text-sm font-semibold text-amber-200 disabled:opacity-40"
            >
              Set sermon start here ({formatTime(currentTime)})
            </button>
          )}
          {onSetEnd && (
            <button
              type="button"
              onClick={() => onSetEnd(currentTime)}
              disabled={!ready}
              className="min-h-12 rounded-lg border border-amber-800 px-4 text-sm font-semibold text-amber-200 disabled:opacity-40"
            >
              Set sermon end here ({formatTime(currentTime)})
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function formatTime(seconds: number): string {
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}
