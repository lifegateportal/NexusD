"use client";

import { useCallback, useState } from "react";
import type { TrailerProject } from "@/lib/schemas/trailer";
import TrailerVideoPreview from "@/app/ebook/library/trailers/TrailerVideoPreview";

type Props = {
  project: TrailerProject;
};

export default function PublishedTrailerPlayer({ project }: Props) {
  const [activeMoment, setActiveMoment] = useState(0);
  const [error, setError] = useState("");
  const handleMomentChange = useCallback((index: number) => setActiveMoment(index), []);
  const handleCurrentTimeChange = useCallback((_timeSeconds: number) => {}, []);
  const handleCropChange = useCallback((
    _timeSeconds: number,
    _cropX: number,
    _cropY: number,
    _zoom: number,
    _fit: "cover" | "contain",
  ) => {}, []);
  const handleError = useCallback((message: string) => setError(message), []);

  return (
    <div className="space-y-3">
      {error && <p role="alert" className="rounded-lg border border-rose-900 bg-rose-950/40 p-3 text-sm text-rose-200">{error}</p>}
      <TrailerVideoPreview
        project={project}
        localVideoUrl={null}
        playRequest={null}
        seekRequest={null}
        activeMoment={activeMoment}
        onActiveMomentChange={handleMomentChange}
        onCurrentTimeChange={handleCurrentTimeChange}
        onCropChange={handleCropChange}
        onError={handleError}
        editable={false}
      />
    </div>
  );
}
