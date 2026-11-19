"use client";

import { useCallback } from "react";
import ShortsPlayer from "@/app/components/ShortsPlayer";
import type { ShortProject } from "@/lib/schemas/video-short";

declare global {
  interface Window {
    __NEXUS_CAPTURE_TIME__?: number;
  }
}

type Props = {
  project: ShortProject;
};

export default function ShortCapturePreview({ project }: Props) {
  const reportTime = useCallback((seconds: number) => {
    window.__NEXUS_CAPTURE_TIME__ = seconds;
  }, []);

  return (
    <main className="fixed inset-0 h-dvh w-screen overflow-hidden bg-black">
      <ShortsPlayer
        project={project}
        embedMode
        captureMode
        onTimeChange={reportTime}
        showErrors
      />
    </main>
  );
}
