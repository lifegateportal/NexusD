"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { NexusNav } from "@/app/components/NexusNav";
import TrailerStudio from "./TrailerStudio";

export default function TrailerStudioShell() {
  const router = useRouter();
  const handleNavSelect = useCallback((id: string) => {
    router.push(id === "ebook" ? "/ebook?tab=pipeline" : "/");
  }, [router]);

  return (
    <div className="flex h-dvh max-h-dvh overflow-hidden bg-shell-950 bg-grid bg-radial-glow safe-area-frame text-slate-100">
      <NexusNav active="library" onSelect={handleNavSelect} />
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-24 pt-5 sm:px-6 lg:pb-6 lg:pt-8">
        <div className="mx-auto max-w-7xl">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-5 sm:mb-8 sm:pb-6">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-cyan-300">Nexus Director · Library</p>
              <h1 className="mt-2 text-3xl font-bold tracking-tight text-white sm:text-4xl">Trailer Studio</h1>
              <p className="mt-3 max-w-3xl text-sm leading-relaxed text-slate-400 sm:text-base">
                Curate a sequence of source moments, preview it in a YouTube embed, and export only from an uploaded source file.
              </p>
            </div>
            <a
              href="/ebook/library?section=videos"
              className="flex min-h-12 items-center rounded-xl border border-slate-700 px-4 text-sm font-semibold text-slate-200"
            >
              Back to Library Studio
            </a>
          </div>
          <TrailerStudio />
        </div>
      </main>
    </div>
  );
}
