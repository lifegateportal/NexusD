"use client";

import { useRef } from "react";
import type { PointerEvent } from "react";

export type ShortsTimelineKind = "caption" | "cut" | "pause" | "broll" | "music" | "overlay";

export type ShortsTimelineItem = {
  id: string;
  kind: ShortsTimelineKind;
  label: string;
  startSeconds: number;
  endSeconds: number;
  editable?: boolean;
};

type Props = {
  startSeconds: number;
  endSeconds: number;
  currentTime: number;
  items: ShortsTimelineItem[];
  onSeek: (seconds: number) => void;
  onRangeChange: (item: ShortsTimelineItem, startSeconds: number, endSeconds: number) => void;
};

type DragState = {
  item: ShortsTimelineItem;
  action: "start" | "move" | "end";
  clientX: number;
  trackWidth: number;
};

const TRACKS: Array<{ kind: ShortsTimelineKind; label: string; color: string }> = [
  { kind: "caption", label: "Captions", color: "bg-cyan-400" },
  { kind: "cut", label: "Transcript cuts", color: "bg-rose-400" },
  { kind: "pause", label: "Pause trims", color: "bg-orange-400" },
  { kind: "broll", label: "B-roll", color: "bg-emerald-400" },
  { kind: "music", label: "Music", color: "bg-violet-400" },
  { kind: "overlay", label: "Images / overlays", color: "bg-amber-300" },
];

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export default function ShortsTimeline({
  startSeconds,
  endSeconds,
  currentTime,
  items,
  onSeek,
  onRangeChange,
}: Props) {
  const dragRef = useRef<DragState | null>(null);
  const duration = Math.max(0.1, endSeconds - startSeconds);
  const playheadValue = Math.max(startSeconds, Math.min(endSeconds, currentTime));

  function handlePointerDown(event: PointerEvent<HTMLDivElement>, kind: ShortsTimelineKind) {
    const target = event.target instanceof HTMLElement
      ? event.target.closest<HTMLElement>("[data-range-action]")
      : null;
    const itemId = target?.dataset.itemId;
    const action = target?.dataset.rangeAction;
    const item = items.find((entry) => entry.id === itemId && entry.kind === kind);
    if (!target || !item || !item.editable || (action !== "start" && action !== "move" && action !== "end")) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = { item, action, clientX: event.clientX, trackWidth: bounds.width };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const delta = (event.clientX - drag.clientX) / drag.trackWidth * duration;
    const itemDuration = drag.item.endSeconds - drag.item.startSeconds;
    let start = drag.item.startSeconds;
    let end = drag.item.endSeconds;
    if (drag.action === "move") {
      start = Math.max(startSeconds, Math.min(endSeconds - itemDuration, start + delta));
      end = start + itemDuration;
    } else if (drag.action === "start") {
      start = Math.max(startSeconds, Math.min(end - 0.1, start + delta));
    } else {
      end = Math.min(endSeconds, Math.max(start + 0.1, end + delta));
    }
    onRangeChange(drag.item, start, end);
  }

  function releasePointer(event: PointerEvent<HTMLDivElement>) {
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function seekFromTrack(event: PointerEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest("[data-range-action]")) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0) return;
    const progress = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    onSeek(startSeconds + progress * duration);
  }

  const playheadPercent = (playheadValue - startSeconds) / duration * 100;

  return (
    <section className="space-y-3 rounded-xl border border-slate-700 bg-slate-950/70 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h4 className="text-sm font-bold text-white">Multitrack timeline</h4>
          <p className="text-xs text-slate-400">Drag a layer to move it; use its edge handles to trim. Swipe horizontally on smaller screens.</p>
        </div>
        <span className="text-xs tabular-nums text-cyan-200">{formatTime(playheadValue)} / {formatTime(endSeconds)}</span>
      </div>
      <label className="block text-xs text-slate-300">
        Playhead
        <input
          type="range"
          min={startSeconds}
          max={endSeconds}
          step="0.05"
          value={playheadValue}
          onChange={(event) => onSeek(Number(event.target.value))}
          className="min-h-12 w-full accent-cyan-400"
          aria-label="Seek through the short"
        />
      </label>
      <div className="overflow-x-auto overscroll-x-contain pb-2" style={{ WebkitOverflowScrolling: "touch" }}>
        <div className="min-w-[42rem] space-y-2">
          <div className="flex justify-between pl-32 text-[10px] tabular-nums text-slate-500">
            <span>{formatTime(startSeconds)}</span>
            <span>{formatTime(startSeconds + duration / 4)}</span>
            <span>{formatTime(startSeconds + duration / 2)}</span>
            <span>{formatTime(startSeconds + duration * 3 / 4)}</span>
            <span>{formatTime(endSeconds)}</span>
          </div>
          <div className="flex min-h-12 items-center gap-2">
            <span className="w-28 shrink-0 text-xs font-medium text-slate-300">Source video</span>
            <div className="relative h-10 flex-1 overflow-hidden rounded-md border border-slate-700 bg-slate-900">
              <span className="absolute inset-y-0 left-0 right-0 bg-slate-700/70" />
              <span className="absolute inset-y-0 w-0.5 bg-cyan-300" style={{ left: `${playheadPercent}%` }} />
            </div>
          </div>
          {TRACKS.map((track) => {
            const trackItems = items.filter((item) => item.kind === track.kind).slice(0, 600);
            return (
              <div key={track.kind} className="flex min-h-12 items-center gap-2">
                <span className="w-28 shrink-0 truncate text-xs font-medium text-slate-300">{track.label}</span>
                <div
                  className="relative h-12 flex-1 rounded-md border border-slate-800 bg-slate-900/80 [touch-action:pan-y]"
                  onPointerDown={(event) => {
                    handlePointerDown(event, track.kind);
                    if (!dragRef.current) seekFromTrack(event);
                  }}
                  onPointerMove={handlePointerMove}
                  onPointerUp={releasePointer}
                  onPointerCancel={releasePointer}
                >
                  <span className="pointer-events-none absolute inset-y-0 w-0.5 bg-cyan-300/80" style={{ left: `${playheadPercent}%` }} />
                  {trackItems.map((item) => {
                    const left = Math.max(0, (item.startSeconds - startSeconds) / duration * 100);
                    const width = Math.max(0.8, (item.endSeconds - item.startSeconds) / duration * 100);
                    return (
                      <div
                        key={item.id}
                        className={`absolute inset-y-1 ${track.color} rounded-sm`}
                        style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }}
                        title={`${item.label}: ${formatTime(item.startSeconds)}–${formatTime(item.endSeconds)}`}
                      >
                        {item.editable !== false && (
                          <>
                        <button
                          type="button"
                          data-range-action="start"
                          data-item-id={item.id}
                          aria-label={`Trim start of ${item.label}`}
                          className="absolute -left-2 top-1/2 z-10 min-h-12 min-w-12 -translate-y-1/2 touch-none rounded-l-full bg-slate-950/70"
                        />
                        <button
                          type="button"
                          data-range-action="move"
                          data-item-id={item.id}
                          aria-label={`Move ${item.label}`}
                          className="absolute inset-y-0 left-3 right-3 touch-none overflow-hidden text-left text-[10px] font-semibold text-slate-950"
                        >
                          <span className="block truncate px-1 leading-8">{item.label}</span>
                        </button>
                        <button
                          type="button"
                          data-range-action="end"
                          data-item-id={item.id}
                          aria-label={`Trim end of ${item.label}`}
                          className="absolute -right-2 top-1/2 z-10 min-h-12 min-w-12 -translate-y-1/2 touch-none rounded-r-full bg-slate-950/70"
                        />
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
