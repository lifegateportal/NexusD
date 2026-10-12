"use client";

import { useEffect, useRef } from "react";
import type { LogEntry, LogLevel } from "@/lib/types";

const LEVEL_CFG: Record<
  LogLevel,
  { tag: string; tagCls: string; msgCls: string }
> = {
  init:    { tag: "INIT", tagCls: "border-cyan-400/30    bg-cyan-400/10    text-cyan-400",    msgCls: "text-slate-200" },
  info:    { tag: "INFO", tagCls: "border-slate-500/30   bg-slate-500/10   text-slate-400",   msgCls: "text-slate-300" },
  success: { tag: "DONE", tagCls: "border-emerald-400/30 bg-emerald-400/10 text-emerald-400", msgCls: "text-slate-100" },
  warn:    { tag: "WARN", tagCls: "border-amber-400/30   bg-amber-400/10   text-amber-400",   msgCls: "text-amber-100" },
  error:   { tag: "ERR",  tagCls: "border-red-400/30     bg-red-400/10     text-red-400",     msgCls: "text-red-100"  },
  stream:  { tag: "STRM", tagCls: "border-violet-400/30  bg-violet-400/10  text-violet-400",  msgCls: "text-slate-200" }
};

type TerminalLogProps = {
  entries: LogEntry[];
  isStreaming?: boolean;
};

export function TerminalLog({ entries, isStreaming = false }: TerminalLogProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries]);

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-cyan-500/15 glass shadow-panel">
      <header className="flex flex-shrink-0 items-center justify-between border-b border-cyan-500/10 px-4 py-3">
        <div className="flex items-center gap-2">
          <span
            className={`h-2.5 w-2.5 rounded-full ${
              isStreaming ? "animate-pulse bg-cyan-400" : "bg-emerald-400"
            }`}
            style={{
              boxShadow: isStreaming
                ? "0 0 10px rgba(6,182,212,0.95)"
                : "0 0 10px rgba(52,211,153,0.80)"
            }}
          />
          <h2 className="text-sm font-semibold uppercase tracking-widest text-slate-200">
            Agent Activity
          </h2>
        </div>
        <span className="rounded-full border border-slate-600/60 bg-slate-800/60 px-2.5 py-1 text-xs tabular-nums text-slate-300">
          {entries.length} events
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
        <ul className="space-y-2">
          {entries.map((entry) => {
            const cfg = LEVEL_CFG[entry.level];
            // Slice UTC ISO string to "HH:MM:SS" — timezone-stable, no locale divergence.
            const time = entry.timestamp
              ? new Date(entry.timestamp).toISOString().slice(11, 19)
              : "";
            return (
              <li
                key={entry.id}
                className="animate-fade-up min-w-0 rounded-xl border border-slate-700/50 bg-slate-900/70 px-3 py-2.5"
              >
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <span
                    className={`inline-flex flex-shrink-0 items-center rounded-md border px-1.5 py-0.5 text-[10px] font-bold tracking-widest ${cfg.tagCls}`}
                  >
                    {cfg.tag}
                  </span>
                  <time suppressHydrationWarning className="flex-shrink-0 text-[10px] tabular-nums text-slate-600">
                    {time}
                  </time>
                </div>
                <p className={`mt-1.5 min-w-0 break-words font-mono text-xs leading-relaxed ${cfg.msgCls}`}>
                  {entry.message}
                </p>
              </li>
            );
          })}
          {isStreaming && (
            <li className="flex min-w-0 items-start gap-2.5 rounded-xl border border-violet-500/30 bg-violet-500/5 px-3 py-2.5">
              <span className="inline-flex flex-shrink-0 items-center rounded-md border border-violet-400/30 bg-violet-400/10 px-1.5 py-0.5 text-[10px] font-bold tracking-widest text-violet-400">
                STRM
              </span>
              <span className="min-w-0 break-words font-mono text-xs leading-relaxed text-slate-400">
                Processing<span className="animate-pulse">...</span>
              </span>
            </li>
          )}
        </ul>
        <div ref={endRef} />
      </div>
    </section>
  );
}
