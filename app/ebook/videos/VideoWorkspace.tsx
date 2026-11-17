"use client";

import { useState } from "react";
import DirectorVideos from "./DirectorVideos";
import ShortsStudio from "./ShortsStudio";

type VideoTab = "library" | "shorts";

export default function VideoWorkspace() {
  const [activeTab, setActiveTab] = useState<VideoTab>("library");

  return (
    <div className="space-y-6">
      <div role="tablist" aria-label="Video workspace" className="flex gap-2 border-b border-slate-800">
        {([
          ["library", "Video Library"],
          ["shorts", "Shorts Studio"],
        ] as const).map(([tab, label]) => (
          <button
            key={tab}
            id={`video-tab-${tab}`}
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            aria-controls={`video-panel-${tab}`}
            onClick={() => setActiveTab(tab)}
            className={`min-h-12 rounded-t-xl px-4 text-sm font-semibold ${
              activeTab === tab
                ? "border-b-2 border-cyan-300 text-cyan-200"
                : "text-slate-400"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <section
        id="video-panel-library"
        role="tabpanel"
        aria-labelledby="video-tab-library"
        hidden={activeTab !== "library"}
      >
        <DirectorVideos />
      </section>
      <section
        id="video-panel-shorts"
        role="tabpanel"
        aria-labelledby="video-tab-shorts"
        hidden={activeTab !== "shorts"}
      >
        {activeTab === "shorts" && <ShortsStudio />}
      </section>
    </div>
  );
}
