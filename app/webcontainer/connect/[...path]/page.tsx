"use client";

import { useEffect, useState } from "react";
import { setupConnect } from "@webcontainer/api/connect";

const initializedWindows = new WeakSet<Window>();

export default function WebContainerConnectPage() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initializedWindows.has(window)) return;
    try {
      setupConnect();
      initializedWindows.add(window);
    } catch (connectError) {
      const message = connectError instanceof Error
        ? connectError.message
        : "The WebContainer preview connection could not start.";
      console.error("[webcontainer/connect] Failed to initialize preview handoff", connectError);
      setError(message);
    }
  }, []);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-slate-950 p-6 text-center text-slate-200">
      <p role={error ? "alert" : "status"} className="max-w-lg text-sm leading-6">
        {error ?? "Connecting this preview tab to the WebContainer project..."}
      </p>
    </main>
  );
}
