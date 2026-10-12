"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { CodingChatPanel } from "@/app/components/CodingChatPanel";
import { NexusNav } from "@/app/components/NexusNav";

export default function CodingPage() {
  const router = useRouter();

  const handleNavSelect = useCallback((id: string) => {
    if (id === "coding") return;
    if (id === "ebook") {
      router.push("/ebook?tab=pipeline");
      return;
    }
    if (id === "translate") {
      router.push("/translate");
      return;
    }
    router.push("/");
  }, [router]);

  return (
    <div className="flex h-dvh max-h-dvh overflow-hidden bg-shell-950 bg-grid bg-radial-glow safe-area-frame text-slate-100">
      <NexusNav active="coding" onSelect={handleNavSelect} />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden pb-[max(env(safe-area-inset-bottom),_3.75rem)] lg:pb-0">
        <main className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain p-2 pb-3 lg:overflow-hidden lg:p-3 lg:pb-3">
          <CodingChatPanel />
        </main>
      </div>
    </div>
  );
}
