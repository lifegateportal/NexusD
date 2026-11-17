"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { NexusNav } from "@/app/components/NexusNav";
import DirectorFaqs from "@/app/ebook/faqs/DirectorFaqs";
import VideoWorkspace from "@/app/ebook/videos/VideoWorkspace";

type LibrarySection = "faqs" | "videos";

export default function DirectorLibraryWorkspace({
  initialSection,
}: {
  initialSection: LibrarySection;
}) {
  const [section, setSection] = useState<LibrarySection>(initialSection);
  const router = useRouter();
  useEffect(() => setSection(initialSection), [initialSection]);
  const handleNavSelect = useCallback((id: string) => {
    router.push(id === "ebook" ? "/ebook?tab=pipeline" : "/");
  }, [router]);

  return (
    <div className="flex h-dvh max-h-dvh overflow-hidden bg-shell-950 bg-grid bg-radial-glow safe-area-frame text-slate-100">
      <NexusNav active="library" onSelect={handleNavSelect} />
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(env(safe-area-inset-bottom),_3.75rem)] pt-5 sm:px-6 lg:pb-6 lg:pt-8">
        <div className="mx-auto max-w-5xl">
          <header className="mb-5 border-b border-slate-800 pb-5 sm:mb-8 sm:pb-6">
            <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-cyan-300">Nexus Director · Library</p>
            <h1 className="mt-2 text-3xl font-bold tracking-tight text-white sm:text-4xl">Library studio</h1>
            <p className="mt-3 max-w-3xl text-sm leading-relaxed text-slate-400 sm:text-base">
              Manage published video content and curated answers from one workspace.
            </p>
          </header>

          <div role="tablist" aria-label="Library tools" className="mb-5 flex gap-2 border-b border-slate-800">
            {([
              ["faqs", "FAQs"],
              ["videos", "Video Studio"],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                id={`director-library-tab-${value}`}
                type="button"
                role="tab"
                aria-selected={section === value}
                aria-controls={`director-library-panel-${value}`}
                onClick={() => {
                  setSection(value);
                  router.replace(`/ebook/library?section=${value}`, { scroll: false });
                }}
                className={`min-h-12 rounded-t-xl px-4 text-sm font-semibold ${
                  section === value
                    ? "border-b-2 border-cyan-300 text-cyan-200"
                    : "text-slate-400"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <section
            id="director-library-panel-faqs"
            role="tabpanel"
            aria-labelledby="director-library-tab-faqs"
            hidden={section !== "faqs"}
          >
            {section === "faqs" && <DirectorFaqs />}
          </section>
          <section
            id="director-library-panel-videos"
            role="tabpanel"
            aria-labelledby="director-library-tab-videos"
            hidden={section !== "videos"}
          >
            {section === "videos" && <VideoWorkspace />}
          </section>
        </div>
      </main>
    </div>
  );
}
